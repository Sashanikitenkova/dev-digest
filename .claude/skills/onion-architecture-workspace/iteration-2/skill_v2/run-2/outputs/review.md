# PR review — `digests` + `memory` modules, `reviewer-core/review/summarize.ts`

Reviewed against `.claude/skills/onion-architecture` (SKILL.md + all five guides) and the
real code the guides cite (`server/src/platform/container.ts`,
`server/src/vendor/shared/adapters.ts`, `server/src/modules/reviews/*`,
`server/src/db/rows.ts`, `reviewer-core/src/{prompt,grounding,review/run}.ts`).

**Verdict: request changes.** Eight blocking layer violations, three of them in one file
(`reviewer-core/src/review/summarize.ts`) that would make the "pure core" package impure in
three separate ways. The `memory` module is close to correct and only needs one import
direction fixed; the `digests` module needs its routes/service/repository boundaries redrawn.

Paths below are given as their real destinations (`server/…`, `reviewer-core/…`) as
instructed; the files under review live in
`.claude/skills/onion-architecture/evals/fixtures/`.

---

## Blocking

### 1. `reviewer-core/src/review/summarize.ts:39-41` — the pure core constructs its own provider and reads an API key

```ts
const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error('OPENROUTER_API_KEY is not configured');
const llm = new OpenRouterProvider(key, { timeoutMs: 60_000 });
```

This is verbatim the case `guides/reviewer-core-llm-port.md` names as "Bad": *"`review/run.ts`
or `prompt.ts` … constructing an `OpenRouterProvider` / reading
`process.env.OPENROUTER_API_KEY` internally instead of receiving `llm` as a parameter."*
`reviewer-core/src/index.ts`'s own doc comment is the contract being broken: *"the only side
effect is an LLM call through an INJECTED LLMProvider (so it is mock-testable)."*

Three concrete costs, not just a style point:

- `reviewer-core` has **two** composition roots (`server/src/platform/container.ts` and the CI
  agent-runner — `guides/layer-model.md` §"Package-level ring inversion"). Hardcoding
  construction here picks one wiring for both and breaks the other.
- It bypasses `SecretsProvider`. In this repo keys live in `~/.devdigest/secrets.json`
  (mode 0600) and are resolved by `Container.buildLlm()` via `this.secrets.get(...)` —
  **never** from `.env`/`process.env` (root `CLAUDE.md`, "Non-default conventions").
- It also drops the injected `estimateCost` hook that `container.ts` passes, so every
  summarise call reports `costUsd: null` and silently falls out of cost attribution.

**Fix:** take the provider as an input — `SummarizeInput.llm: LLMProvider` — and delete the
import of `../llm/openrouter.js` and the `process.env` read entirely. Each caller passes
`await container.llm('openrouter')` (server) or its own constructed provider (runner).

### 2. `reviewer-core/src/review/summarize.ts:1, 43-46` — filesystem access inside `reviewer-core`

```ts
import { readFile } from 'node:fs/promises';
…
for (const path of input.skillPaths ?? []) {
  skills.push(await readFile(path, 'utf8'));
}
```

`reviewer-core/CLAUDE.md`: *"No DB, GitHub, or filesystem."* The SKILL.md quick-reference row
covers this precisely: *"Give `reviewer-core` a new capability that needs a DB row or a file
read → resolve it to a plain string/object in the caller (`server`), pass it in as data."*
`ReviewInput` already models this correctly — its doc comment says *"Resolved skill bodies
(NOT slugs)"*. This file invented `skillPaths?: string[]` instead of following it.

Beyond purity: reading arbitrary absolute paths handed in by a caller is a path-traversal
surface in the CI runner, and it makes the function untestable without a real filesystem
fixture.

**Fix:** replace `skillPaths?: string[]` with `skills?: string[]` (already-resolved bodies),
mirroring `ReviewInput`. The server resolves skill files; the core never touches `node:fs`.

### 3. `reviewer-core/src/review/summarize.ts:55-66` — findings returned without passing the grounding gate

```ts
const result = await llm.completeStructured({ … });
return { headline: result.data.headline, findings: result.data.findings, model: SUMMARY_MODEL };
```

Raw model findings go straight to the caller. This is the mandatory domain invariant, stated
in three places: root `CLAUDE.md` (*"every finding must cite a real diff line or it's
dropped"*), `reviewer-core/CLAUDE.md` (*"Grounding is mandatory — never bypass
`groundFindings()`"*), and SKILL.md's rules checklist. `guides/reviewer-core-llm-port.md`
names this exact shape as "Bad": *"a new caller … reading `StructuredResult.data.findings`
directly off the `LLMProvider` response … reintroduces hallucinated line citations."*

Note the second-order damage: because this is a *second* pass over the same diff, any
hallucinated location it invents is the one that gets promoted "above the fold on the PR
page" — the most visible position in the product.

**Fix:** pipe through the gate before returning, as `review/run.ts:216` does:

```ts
const ground = groundFindings(result.data.findings, input.diff);
return { headline: result.data.headline, findings: ground.kept, model: SUMMARY_MODEL };
```

(and don't trust any model-reported score — recompute it from survivors).

### 4. `server/src/modules/digests/service.ts:2, 64` — concrete adapter imported and constructed outside the composition root

```ts
import { OctokitGitHubClient } from '../../adapters/github/octokit.js';
…
const github = new OctokitGitHubClient(process.env.GITHUB_TOKEN ?? '');
```

`guides/layer-model.md`: *"If you find yourself importing from `server/src/adapters/*`
anywhere outside `container.ts`, that's a Dependency Rule violation."*
`guides/fastify-routing-and-di.md` §"Composition-root discipline" repeats it and describes
this precise failure ("just fetch the PR title quickly") in its Bad example.

Consequences here are concrete, not theoretical:

- It bypasses `ContainerOverrides.github`, so **the test in this same PR
  (`digests-service.test.ts`) will make live GitHub requests** — it overrides `llm`,
  `embedder` and `git`, but the service never consults the container for GitHub.
- `process.env.GITHUB_TOKEN ?? ''` duplicates secret handling that
  `Container.github()` already does properly (`await this.secrets.get('GITHUB_TOKEN')`,
  throwing `ConfigError` when absent) and, again, reads a secret from the environment, which
  this repo explicitly does not do. The `?? ''` degrades a missing token into unauthenticated
  calls that fail later with a confusing 401/404 instead of failing fast.

**Fix:** `const github = await this.container.github();` and delete the adapter import.

### 5. `server/src/modules/digests/service.ts:1, 5, 32-51 and 57-60` — Drizzle queries inside the service

```ts
import { and, desc, eq, gte } from 'drizzle-orm';
import * as t from '../../db/schema.js';
…
const merged = await this.container.db.select({ … }).from(t.pullRequests)…
const [repoRow] = await this.container.db.select({ … }).from(t.repos)…
```

`guides/drizzle-repository-pattern.md` §"Who touches Drizzle" lists exactly this as "Bad":
*"a service or route file with `import * as t from '../../db/schema.js'` and its own
`db.select()…` inline."* `reviews/repository.ts`'s doc comment states the invariant as
"The ONLY layer touching the DB for the review domain." The module already has a
`DigestsRepository` — these two queries simply weren't put in it.

**Fix:** add `listMergedInWindow(workspaceId, from, to, limit)` and a repo lookup to
`DigestsRepository` (or, since `repos`/`pull_requests` are another domain's tables, take the
PR list through the existing cross-cutting accessor pattern — `container.reviewRepo` already
owns `pull.repo.ts`; extend that rather than re-querying `t.pullRequests` from a third
module). The service should not import `drizzle-orm` or `db/schema.js` at all.

### 6. `server/src/modules/digests/service.ts:6, 83-85` — reaches into another module's per-aggregate repository file

```ts
import { nearest } from '../memory/repository/search.repo.js';
…
const related = await nearest(this.container.db, workspaceId, queryVector, { … });
```

Two rules broken at once:

- **Reaching past a facade.** `guides/drizzle-repository-pattern.md` §"Growing a repository
  beyond one aggregate" names it directly as Bad: *"a caller importing
  `repository/review.repo.ts`'s functions directly instead of going through the
  `ReviewRepository` facade class, which defeats the point of having a stable composed API."*
  `MemoryRepository.nearest()` exists in this very PR and is what should be called.
- **Cross-module data-layer coupling.** `db/rows.ts`'s doc comment explains the convention:
  consumers reference shapes *"WITHOUT importing another module's data layer."*
  `digests` is now welded to `memory`'s internal file layout — the moment `memory` splits
  `search.repo.ts` again, `digests` breaks.

It also skips `dedupeByContent()`, so the "_context:_" lines can repeat the same sentence —
the exact failure `memory/helpers.ts:9-13` says "reads as broken".

**Fix:** call `MemoryService.search(workspaceId, query, { limit })` (it already embeds,
dedupes and marks-used), or at minimum `new MemoryRepository(container.db).nearest(...)`.
Calling the service also removes the duplicated embed step at lines 80-81.

### 7. `server/src/modules/digests/routes.ts:6, 28, 36, 43, 52` — the route owns the repository and the business logic

```ts
const repo = new DigestsRepository(app.container.db);
…
const existing = await repo.findByPeriod(workspaceId, periodStart, periodEnd);
if (existing && !req.body.regenerate) return { digest: existing, cached: true };
if (existing) await repo.deleteById(workspaceId, existing.id);
const digest = await service.build(workspaceId, periodStart, periodEnd);
…
return { digests: await repo.listRecent(workspaceId, req.query.limit) };
```

SKILL.md: *"`routes.ts` is presentation-only: Zod validation → one or more service calls →
response shaping. No direct repository/adapter calls, no business branching."*
`guides/fastify-routing-and-di.md` §"Where business logic lives" gives the identical Bad
example: *"a route handler with inline `if (…) { … } else { … }` branching plus direct
`repo.insertReview(...)` calls."* Compare `reviews/routes.ts:19-22`, which constructs
**only** a service.

What is actually in the handler is the module's core policy — the period window (line 34),
the reuse-vs-rebuild decision (38-44), and the delete-then-rebuild sequence — none of which
can be unit-tested without booting Fastify, and none of which is atomic: the delete at line 43
commits before `service.build()` runs, so a model failure leaves the workspace with the old
digest destroyed and no new one.

**Fix:** one service method per route —
`service.generate(workspaceId, { periodDays, regenerate })` returning `{ digest, cached }`
(period math, lookup, reuse/rebuild decision and insert-then-delete ordering all inside), and
`service.listRecent(workspaceId, limit)`. Routes keep only `getContext` → one call → shape.

### 8. `server/src/modules/memory/repository/item.repo.ts:4` and `search.repo.ts:4` — aggregates import types back from the facade

```ts
import type { InsertMemory, MemoryRow } from '../repository.js';   // item.repo.ts
import type { MemoryRow, NearestOptions } from '../repository.js'; // search.repo.ts
```

while `repository.ts:13-14` imports both aggregate files back. This is the cycle
`guides/drizzle-repository-pattern.md` §"Types flow down, not back up" was written for:
*"An aggregate that does `import type { Row } from '../repository.js'` while `repository.ts`
imports that same file back forms a cycle between a class and its own parts. It usually still
compiles — type-only imports are erased — which is exactly why it survives review."*
The reference implementation (`reviews/repository/{review,run,pull}.repo.ts`) takes its row
types from `server/src/db/rows.ts` instead.

The facade split itself is correct and well-motivated — the doc comment's "they share a table
but not a reason to change" is exactly the axis-of-change justification
`guides/pitfalls-and-tradeoffs.md` endorses. Only the import direction is wrong.

**Fix:** move `MemoryRow`, `InsertMemory` and `NearestOptions` into a module-local
`server/src/modules/memory/types.ts` (or `db/rows.ts` if other modules will consume
`MemoryRow` — `digests` arguably will). Have `repository.ts` and both aggregates import from
there, re-exporting from `repository.ts` if you want the public type API unchanged, so the
dependency runs facade → aggregates → types.

---

## High

### 9. `server/src/modules/index.ts` — neither module is registered

The PR adds `modules/digests/routes.ts` and `modules/memory/routes.ts` but contains no change
to `server/src/modules/index.ts`. SKILL.md: *"New module = `routes.ts` + `service.ts` +
`repository.ts` (as needed), registered once in `modules/index.ts` — no ad hoc extra top-level
files, no bypassing the static registry."* `modules/index.ts:23-26` says the same
("ADD A MODULE: create `modules/<name>/routes.ts` … then add one import + one entry below").

Every route in this PR is currently unreachable, and `digests-service.test.ts:63-69`
(`expect(res.statusCode).toBe(200)`) will get a 404.

**Fix:** add `import digests from './digests/routes.js';` and
`import memory from './memory/routes.js';` plus the two registry entries.

### 10. `reviewer-core/src/review/summarize.ts:48-60` — the file does not type-check against the APIs it calls

Three mismatches against the real signatures:

- `assemblePrompt({ systemPrompt: … })` — `PromptParts` (`prompt.ts:200-245`) has no
  `systemPrompt`; the field is `system`.
- `diff: input.diff` typed `UnifiedDiff` — `PromptParts.diff` is `string`
  (`prompt.ts:241-242`).
- `prompt.system` / `prompt.user` — `assemblePrompt` returns
  `AssembledPrompt { messages, assembly }` (`prompt.ts:247-250`), not `{ system, user }`.
- `llm.completeStructured({ model, system, user, schema })` — `StructuredRequest`
  (`adapters.ts:53-70`) requires `messages: ChatMessage[]` and `schemaName: string`; there is
  no `system`/`user` field.

`reviewer-core`'s build *is* the type-check (`npm run typecheck`, per its CLAUDE.md), so this
cannot have been compiled. Follow `review/run.ts:193-196` for the call shape.

Related, same file:

- **Line 12 — `z.array(z.custom<Finding>())` validates nothing.** `z.custom` with no
  refinement accepts any value, so the structured-output contract is a type-level fiction and
  the JSON-Schema handed to the model carries no shape for `findings`. Use the real `Finding`
  Zod schema from `@devdigest/shared`.
- **Line 7 — `SUMMARY_MODEL` hardcoded in the core.** Model choice is a caller/config
  decision (the server resolves models from settings). Accept it on `SummarizeInput` with a
  default, rather than pinning `anthropic/claude-3.5-haiku` inside the engine.

### 11. `server/src/modules/digests/service.ts:80-81` — `container.embedder()` is called unguarded

```ts
const embedder = await this.container.embedder();
const [queryVector] = await embedder.embed([lines.join('\n')]);
```

`Container.embedder()` throws `ConfigError` when `config.embeddingsEnabled` is false, and its
own comment states the convention: *"All callers wrap this in try/catch and degrade
gracefully (memory/RAG simply returns no hits)."* `MemoryService.embedOrNull()` (lines 57-65)
in this same PR does it correctly.

As written, a workspace with embeddings disabled loses **the entire digest** — after paying
for one LLM call per merged PR — because an optional "related context" footer could not be
built.

**Fix:** reuse `MemoryService.search()` (finding 6), which already swallows this; or wrap
lines 80-88 in try/catch and continue with no context lines.

### 12. `server/src/modules/digests/service.ts:57-60, 69` — one repo is looked up but every PR's detail is fetched against it

```ts
const [repoRow] = await this.container.db.select({ … }).from(t.repos)
  .where(eq(t.repos.id, merged[0]!.repoId));
…
const detail = await github.getPullRequest({ owner: repoRow.owner, name: repoRow.name }, pr.number);
```

`merged` is every merged PR in the workspace across **all** imported repos (the query filters
on `workspaceId`, not `repoId`). Taking `merged[0].repoId` and applying it to all of them
means PR #42 of repo B is fetched as PR #42 of repo A — silently returning a different PR's
body, or 404-ing and aborting the digest. A multi-repo workspace is the normal case here.

**Fix:** group the merged PRs by `repoId`, resolve each repo once, and fetch each PR against
its own repo ref.

---

## Medium

### 13. `server/test/digests-service.test.ts` — a real-Postgres test named as a unit test

SKILL.md: *"Test placement mirrors the ring: mocked-ports-only → `*.test.ts`; real-Postgres →
`*.it.test.ts`. A 'unit' test that needs a live DB is a signal a boundary leaked."*
Lines 15 and 25 (`dockerAvailable()`, `startPg()`) make this unambiguously an integration
test; every other DB-backed suite in `server/test/` follows the convention
(`reviews.it.test.ts`, `blast.it.test.ts`, `skills.it.test.ts`, …).

**Fix:** rename to `server/test/digests.it.test.ts`.

Two further problems in the same file, both symptoms of the findings above rather than
separate defects: it will 404 until finding 9 is fixed, and it will hit live GitHub until
finding 4 is fixed (no `github:` entry in `overrides`, though `MockGitHubClient` exists in
`src/adapters/mocks.ts`). Add `github: new MockGitHubClient()` to the overrides at line 30.
The test also never exercises the `cached: true` path its own doc comment (line 12) advertises
— worth adding once the reuse decision lives in the service and can be called directly.

### 14. `server/src/modules/digests/repository.ts:24-40` — `findByPeriod` does containment, not the exact match its doc claims

The doc comment (lines 17-19) says *"Periods are matched on their exact boundaries rather than
by overlap … only an exact re-request counts as a rebuild of the same digest"*, but the
predicate is `gte(periodStart, periodStart)` + `lte(periodEnd, periodEnd)` — i.e. "any digest
whose window falls *inside* the requested one".

So a stored 7-day digest is returned as a cache hit for a later 30-day request, and the user
gets a week of PRs labelled as a month. Combined with `routes.ts:38`, that also means the
30-day rebuild path deletes the 7-day digest. There is no `orderBy`/`limit(1)` either, so
which row wins is arbitrary.

**Fix:** `eq(t.digests.periodStart, periodStart)` and `eq(t.digests.periodEnd, periodEnd)` to
match the stated contract — noting that `routes.ts:33` derives `periodEnd = new Date()`, so
exact equality will never hit until the window is snapped to a stable boundary (day/week).
Decide which semantics you want and make code and comment agree.

### 15. `server/src/modules/memory/service.ts:48` — `markUsed` is awaited, contradicting its own stated invariant

`item.repo.ts:21` says *"Recency feeds ranking later; a failed touch must never fail the
read"*, but the service awaits it bare:

```ts
await this.repo.markUsed(rows.map((r) => r.id));
return dedupeByContent(rows);
```

A write failure (or a lock wait) now fails a read that had already succeeded — precisely what
the comment forbids, and at odds with the module's own "must not take the others down with
it" degradation contract (`service.ts:19-26`).

**Fix:** `void this.repo.markUsed(ids).catch(() => {});` or wrap in try/catch, and return the
rows regardless.

### 16. `server/src/modules/digests/service.ts:68-78` — sequential GitHub + LLM calls per PR inside the request

Up to `MAX_PRS_PER_DIGEST` (40) round trips to GitHub *and* 40 LLM completions, serially,
inside one HTTP request. At a realistic couple of seconds per model call that is minutes of
wall clock under a default Fastify/proxy timeout, and there is no partial-failure handling —
PR #37 failing discards the 36 completions already paid for.

This isn't a layering finding, but it is a design point worth settling before merge: this repo
already has `JobRunner` (`container.jobs`) for exactly this shape of work. Consider making
`POST /digests` enqueue and return a job id, or at minimum bound concurrency and tolerate
per-PR failures.

---

## Low / notes

- **`server/src/modules/digests/service.ts:53-54`** — `NotFoundError('No pull requests were
  merged in this period')` turns a legitimately quiet week into an HTTP 404. "Nothing merged"
  is a valid result, not a missing resource; return an empty digest (or a 200 with
  `digest: null`) so the Monday-morning panel renders instead of erroring.
- **`server/src/modules/digests/service.ts:44-49`** — the window has a lower bound
  (`gte(updatedAt, periodStart)`) but no upper bound, and filters on `updatedAt` rather than a
  merge timestamp. Harmless while `routes.ts` always sets `periodEnd = now`, but it silently
  breaks the moment an explicit window is supported, and `updatedAt` moves on late comment
  activity so a PR can drift into or out of a period after the fact.
- **`server/src/modules/digests/routes.ts:52`** — `GET /digests` returns raw `DigestRow`s.
  Acceptable under this repo's documented row-types-as-DTOs compromise
  (`guides/drizzle-repository-pattern.md`), so not a finding — flagging only because it means
  a schema column rename is an API break.
- **`reviewer-core/src/review/summarize.ts`** is not exported from `reviewer-core/src/index.ts`;
  add it there if the server is meant to call it.

---

## Checked and clean

Recording these so the next reviewer doesn't re-litigate them:

- **`memory/routes.ts`** — textbook presentation-only: Zod schemas, `getContext`, one service
  call per handler, no repository or adapter reference. Matches `reviews/routes.ts`.
- **`memory/service.ts`** — depends on `Container` (the documented whole-container convention,
  explicitly *not* a finding per `guides/pitfalls-and-tradeoffs.md`), constructs no adapters,
  touches no Drizzle, and degrades gracefully around the embedder. Aside from finding 15 this
  is the model the `digests` service should follow.
- **The `memory` facade-over-`repository/<aggregate>.repo.ts` split** — the documented
  convention (`reviews/repository.ts`), with a genuine axis-of-change justification in its doc
  comment. Not premature structure; only the import direction (finding 8) is wrong.
- **`constants.ts` / `helpers.ts` in both modules** — established across ~13 existing modules
  (`reviews`, `blast`, `brief`, `intent`, …), pure and I/O-free. Not "ad hoc extra top-level
  files".
- **`digests/repository.ts` and `memory/repository/*.ts`** — correctly the only files holding
  Drizzle for their own tables; every query is workspace-scoped (`eq(workspaceId, …)`), with
  no tenant-leak paths. `digests`'s single-aggregate un-split repository is proportionate to
  its domain.
- **No new port was needed.** Both modules use existing capabilities (`GitHubClient`,
  `LLMProvider`, `Embedder`) already declared in `vendor/shared/adapters.ts`, so the
  "port before adapter" rule and the "a port names a capability, not a vendor" rule are not
  in play here.

---

## Summary of required changes

| # | File | Change |
|---|---|---|
| 1 | `reviewer-core/src/review/summarize.ts:39-41` | Inject `llm: LLMProvider`; drop `OpenRouterProvider` import and `process.env` read |
| 2 | `reviewer-core/src/review/summarize.ts:1,43-46` | `skills: string[]` instead of `skillPaths`; drop `node:fs/promises` |
| 3 | `reviewer-core/src/review/summarize.ts:62-66` | Route findings through `groundFindings()` |
| 4 | `server/src/modules/digests/service.ts:2,64` | `await this.container.github()` |
| 5 | `server/src/modules/digests/service.ts:32-60` | Move queries into `DigestsRepository` / the shared pulls repo |
| 6 | `server/src/modules/digests/service.ts:6,83` | Go through `MemoryService`/`MemoryRepository`, not `search.repo.js` |
| 7 | `server/src/modules/digests/routes.ts:28,36-46,52` | Delete the repo handle; move period math + reuse/rebuild into the service |
| 8 | `server/src/modules/memory/repository/{item,search}.repo.ts:4` | Types from a module-local `types.ts` (or `db/rows.ts`), not the facade |
| 9 | `server/src/modules/index.ts` | Register `digests` and `memory` |
| 10 | `reviewer-core/src/review/summarize.ts:48-60` | Fix `assemblePrompt`/`completeStructured` call shapes; real `Finding` schema; model as input |
| 11 | `server/src/modules/digests/service.ts:80` | Guard `container.embedder()` |
| 12 | `server/src/modules/digests/service.ts:57-69` | Resolve a repo ref per PR, not `merged[0]` for all |
| 13 | `server/test/digests-service.test.ts` | Rename to `digests.it.test.ts`; add `github: new MockGitHubClient()` |
| 14 | `server/src/modules/digests/repository.ts:24-40` | Exact-boundary match, or fix the doc comment |
| 15 | `server/src/modules/memory/service.ts:48` | Don't let `markUsed` fail the read |
