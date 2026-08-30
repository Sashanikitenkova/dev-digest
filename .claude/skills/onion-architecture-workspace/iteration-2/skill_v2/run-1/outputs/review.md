# PR Review — `digests` + `memory` modules, `reviewer-core/review/summarize.ts`

Reviewed against `.claude/skills/onion-architecture` (SKILL.md + all five guides),
`server/src/platform/container.ts`, `server/src/vendor/shared/adapters.ts`,
`server/src/modules/index.ts`, `server/src/db/rows.ts`, `reviewer-core/src/index.ts`
and `TESTING.md`.

Paths below are relative to the fixture root and should be read as
`server/...` and `reviewer-core/...`.

**Verdict: request changes.** Seven blocking layering violations, three of them in
one file (`reviewer-core/src/review/summarize.ts`) that breaks the engine's purity
guarantee on all three of its axes at once.

---

## Blocking

### 1. `reviewer-core/src/review/summarize.ts:38-66` — findings returned without `groundFindings()`

`summarizeReview()` produces `Finding[]` straight off `result.data.findings` (line 64)
and hands them to the caller. It is a new diff-anchored review path — it takes a
`UnifiedDiff` (line 18) and emits findings with line citations — so it must pass
through the mandatory citation-grounding gate.

`reviewer-core/CLAUDE.md`: "Grounding is mandatory — never bypass `groundFindings()`
or trust the model's self-reported score." The `reviewer-core-llm-port` guide names
this exact shape as its "bad" example: a new flow reading
`StructuredResult.data.findings` directly and persisting it reintroduces the
hallucinated line numbers the invariant exists to prevent.

**Fix:** run the model output through
`groundFindings(result.data.findings, input.diff)` and return `kept`; recompute any
score from the survivors, never from the model's own claim.

### 2. `reviewer-core/src/review/summarize.ts:5,39-41` — provider constructed and API key read inside the pure core

```ts
const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error('OPENROUTER_API_KEY is not configured');
const llm = new OpenRouterProvider(key, { timeoutMs: 60_000 });
```

`reviewer-core/src/index.ts` states the contract: "the only side effect is an LLM
call through an INJECTED LLMProvider." Today `grep -rn 'process\.env' reviewer-core/src`
(excluding tests) returns nothing — this file would be the first breach. The
`OpenRouterProvider`-lives-in-the-core exception covers the adapter *file*; it does
not license other files in the package to construct it. Construction belongs to each
consumer's composition root — `container.ts:193` for the studio, the CI runner for
the action — and there are two of them, so `summarize.ts` cannot pick one.

Concretely this also makes the function untestable: no `ContainerOverrides.llm`
mock can reach it, and it hard-codes the openrouter provider for a caller that may
have been configured for openai or anthropic.

**Fix:** add `llm: LLMProvider` to `SummarizeInput` and delete the import,
the env read and the `new`. Callers pass `await container.llm(...)`.

### 3. `reviewer-core/src/review/summarize.ts:1,19,44-46` — filesystem access inside `reviewer-core`

```ts
for (const path of input.skillPaths ?? []) {
  skills.push(await readFile(path, 'utf8'));
}
```

"NO database, GitHub, or filesystem access" (`reviewer-core/src/index.ts`), and
`review/run.ts` spells out the resolution rule: "Skill bodies / memory / specs are
RESOLVED strings here: the caller turns AgentManifest skill slugs into bodies (DB in
the studio, fs in the runner)." Taking `skillPaths` forces the engine to assume a
filesystem layout that the studio server does not have — its skill bodies live in
Postgres, reachable via `container.skillsRepo`.

**Fix:** replace `skillPaths?: string[]` with `skills?: string[]` (already-resolved
bodies) and drop the `node:fs/promises` import. This mirrors `ReviewInput`.

### 4. `server/src/modules/digests/service.ts:2,64` — concrete adapter constructed outside the composition root, secret read from `process.env`

```ts
import { OctokitGitHubClient } from '../../adapters/github/octokit.js';
...
const github = new OctokitGitHubClient(process.env.GITHUB_TOKEN ?? '');
```

Two rules broken at once:

- Only `platform/container.ts` may import from `adapters/*` (layer-model guide:
  "If you find yourself importing from `server/src/adapters/*` anywhere outside
  `container.ts`, that's a Dependency Rule violation"). The container already
  exposes `await container.github(): Promise<GitHubClient>` (`container.ts:161`).
- Secrets come from `SecretsProvider`, not the environment. `CLAUDE.md`: secrets
  "live in `~/.devdigest/secrets.json` (mode 0600), never `.env`/DB", and
  `container.github()` does exactly that lookup plus a `ConfigError` when absent.
  The `?? ''` here silently builds an unauthenticated client instead.

The damage is already visible in the PR: `test/digests-service.test.ts:30-35` injects
`llm`, `embedder` and `git` overrides but has no way to inject GitHub, so the test as
written will make live github.com requests from CI.

**Fix:** `const github = await this.container.github();` and delete the import.

### 5. `server/src/modules/digests/service.ts:1,5,32-62` — Drizzle queries in the service

The service imports `db/schema.js` and runs `this.container.db.select()` against
`pullRequests` (lines 32-51) and `repos` (lines 57-60), while a
`DigestsRepository` sits right beside it. `reviews/repository.ts` states the
invariant this breaks: the repository is "the ONLY layer touching the DB" for its
domain, and the drizzle guide's "bad" example is precisely a service with
`import * as t from '../../db/schema.js'` and an inline `db.select()`.

Note the queries are also cross-domain: `pullRequests` is the `reviews`/`pulls`
domain, which the container already publishes as `container.reviewRepo`
(`container.ts:107`) for exactly this reason.

**Fix:** move the merged-PR window query and the repo lookup onto
`DigestsRepository` (or consume `container.reviewRepo`), and drop the
`drizzle-orm` + `db/schema.js` imports from `service.ts`.

### 6. `server/src/modules/digests/routes.ts:6,28,36,43,52` — route owns the repository and the business logic

```ts
const repo = new DigestsRepository(app.container.db);
...
const existing = await repo.findByPeriod(workspaceId, periodStart, periodEnd);
if (existing && !req.body.regenerate) return { digest: existing, cached: true };
if (existing) await repo.deleteById(workspaceId, existing.id);
```

Routes are presentation-only: Zod validation → service call → response shaping
(fastify guide; `reviews/routes.ts` is the canonical example). This handler
constructs a repository directly, computes the period window (lines 33-34), and
branches on domain state — the reuse-or-rebuild rule, which is the module's most
interesting business rule per its own docstring. `GET /digests` (line 52) bypasses
the service entirely.

The consequence is the guide's stated one: this rule can now only be tested by
booting Fastify, which is exactly what `digests-service.test.ts` had to do.

**Fix:** give `DigestsService` a `generate(workspaceId, { periodDays, regenerate })`
that computes the window, does the lookup/delete/build, and returns
`{ digest, cached }`; add `list(workspaceId, limit)`. The route then parses and
delegates, and `DigestsRepository` is constructed only inside the service (as it
already is at `service.ts:28`).

### 7. `server/src/modules/digests/service.ts:6,83` — reaches into another module's per-aggregate repository file

```ts
import { nearest } from '../memory/repository/search.repo.js';
...
const related = await nearest(this.container.db, workspaceId, queryVector, {...});
```

Two violations stacked:

- **Cross-module data-layer import.** The convention for sharing data access
  between modules is a container-published repository — `container.agentsRepo`,
  `container.skillsRepo`, `container.reviewRepo`, whose comment says they exist
  "so consuming modules use `container.agentsRepo` instead of reaching into
  another module's folder" (`container.ts:71-76`).
- **Bypassing the facade.** Even within `memory`, `search.repo.ts` is an internal
  aggregate file. The drizzle guide names "a caller importing
  `repository/review.repo.ts`'s functions directly instead of going through the
  `ReviewRepository` facade class" as the inverse mistake that "defeats the point
  of having a stable composed API." `MemoryRepository.nearest` (`memory/repository.ts:47`)
  is the supported entry point.

**Fix:** either expose `memoryRepo` (or the `MemoryService`) on `Container` and call
`container.memoryRepo.nearest(...)`, or — better, since digests wants *search*, not
storage — call `MemoryService.search()`, which also applies `dedupeByContent` and
`markUsed`. Do not import `search.repo.js` from another module.

---

## High

### 8. `server/src/modules/memory/repository/item.repo.ts:4` and `search.repo.ts:4` — aggregates import types back from their facade

```ts
import type { InsertMemory, MemoryRow } from '../repository.js';   // item.repo.ts
import type { MemoryRow, NearestOptions } from '../repository.js'; // search.repo.ts
```

while `repository.ts:13-14` imports both files back. That is a cycle between a class
and its own parts — the drizzle guide calls out this exact pattern, including why it
survives review ("it usually still compiles — type-only imports are erased"). The
real cost is that neither aggregate can be tested or reused without dragging the
facade in. `reviews/repository/*.repo.ts` avoids this by taking its row types from
`db/rows.ts`.

**Fix:** move `MemoryRow`, `InsertMemory` and `NearestOptions` to a module-local
`memory/types.ts` (or add `MemoryRow` to `server/src/db/rows.ts`, which is where
cross-cutting row types live), and have the facade *and* the aggregates import from
there. Dependency then runs facade → aggregates → types, one way.

### 9. Neither module is registered — `server/src/modules/index.ts` is unchanged

The PR adds `modules/digests/routes.ts` and `modules/memory/routes.ts` but no entry
in the static registry. `modules/index.ts:23-26`: "ADD A MODULE: create
`modules/<name>/routes.ts` exporting a default Fastify plugin, then add one import +
one entry below." Without it, every route in this PR is dead code — and
`digests-service.test.ts` would 404 rather than fail meaningfully.

**Fix:** add `import digests from './digests/routes.js';` and
`import memory from './memory/routes.js';` plus both entries in the `modules` object.

### 10. `server/test/digests-service.test.ts:2,15,25-27` — DB-backed test using the unit-lane filename

The file calls `startPg()` / `dockerAvailable()` from `test/helpers/pg.ts` and seeds a
real Postgres, but is named `*.test.ts`. `TESTING.md:86-89`: "A DB-backed test that
imports `test/helpers/pg.ts` must use the `.it.test.ts` suffix" — the unit lane runs
`--exclude '**/*.it.test.ts'`, so as named this test runs in the Docker-less unit job
and silently self-skips (`describe.skip` at line 16) while never being selected by the
integration lane either. It is currently a test that never runs anywhere. The skill
states the same rule: "mocked-ports-only → `*.test.ts`; real-Postgres → `*.it.test.ts`."

**Fix:** rename to `server/test/digests.it.test.ts`. Note this is also an HTTP-level
test, not a service test — once finding 6 is fixed, the reuse-or-rebuild rule can be
covered by a fast mocked-port unit test in `digests-helpers.test.ts` style, with the
`.it.test.ts` file kept only for the real-Postgres path.

---

## Medium

### 11. `server/src/modules/digests/service.ts:80-81` — `container.embedder()` called without the degrade-gracefully guard

`container.ts:203-211` documents the contract: `embedder()` **throws** a `ConfigError`
when `EMBEDDINGS_ENABLED` is false, and "All callers wrap this in try/catch and
degrade gracefully." `MemoryService.embedOrNull` (`memory/service.ts:57-65`) does this
correctly. `DigestsService.build` does not, so on a default local install — where
embeddings are off — digest generation fails outright on a step that only appends
optional context lines.

**Fix:** wrap lines 80-89 in try/catch (or reuse the memory module's
`embedOrNull`-equivalent through `MemoryService.search`, per finding 7) and skip the
related-context block when it is unavailable.

### 12. `reviewer-core/src/review/summarize.ts:48-60` — the call does not match the real `assemblePrompt` / `LLMProvider` API

- `assemblePrompt` takes `PromptParts` — `{ system, skills?, diff: string, task? }`
  (`reviewer-core/src/prompt.ts:200-245`) — not `{ systemPrompt, diff: UnifiedDiff }`,
  and returns `{ messages, assembly }`, so `prompt.system` / `prompt.user`
  (lines 57-58) do not exist.
- `StructuredRequest` (`vendor/shared/adapters.ts:55-70`) requires `messages` and
  `schemaName`; there are no `system`/`user` fields.

As written this file does not type-check. Worth calling out because it suggests the
file was authored against a remembered API rather than the current one — the same
root cause as findings 2 and 3.

**Fix:** after injecting `llm`, call
`llm.completeStructured({ model, schema: SummaryPayload, schemaName: 'summary', messages: prompt.messages })`
and pass a rendered diff string into `assemblePrompt`.

### 13. `server/src/modules/digests/service.ts:57-60` — one repo resolved for all PRs in the window

`repoRow` is looked up from `merged[0]!.repoId` and then used as the GitHub repo for
every PR in the loop (line 69). A workspace with two imported repos will fetch PR
numbers from the wrong repository — wrong data, not just a missing one, since PR
numbers collide across repos.

**Fix:** group the merged PRs by `repoId` and resolve each repo once (a
`repository.ts` method returning PRs joined to their repo owner/name is the natural
shape, and lands the query in the right layer per finding 5).

## Low / non-blocking

- **`server/src/modules/memory/service.ts:39-50` → `routes.ts:46`** — `search()` returns
  full `MemoryRow`s, so every response ships the 1536-float `embedding` column
  (`db/schema/knowledge.ts`) to the browser. Project a narrower row in
  `search.repo.ts` or strip it in the service.
- **`server/src/modules/digests/repository.ts:24-40`** — the docstring says periods are
  "matched on their exact boundaries", but `gte(periodStart) + lte(periodEnd)` matches
  any digest *contained within* the window, with no `limit(1)` or ordering, so an
  arbitrary contained row can be returned and then deleted by `routes.ts:43`. Use
  `eq` on both boundaries, or make the docstring match the query.
- **`reviewer-core/src/review/summarize.ts:11`** — `z.array(z.custom<Finding>())`
  validates nothing at runtime; the parse-with-repair loop cannot catch a malformed
  finding. Reuse the real `Finding` schema from `@devdigest/shared`.
- **`server/src/modules/digests/service.ts:68-78`** — one GitHub round-trip plus one
  LLM call per PR, sequentially, up to `MAX_PRS_PER_DIGEST = 40`. Not an architecture
  issue, but worth bounding concurrency once the calls sit behind the repository/port.
- **`server/test/digests-service.test.ts:9-13`** — the docstring promises "a second
  request for the same window reuses the stored row", but no test asserts
  `cached: true`. That is the module's headline behaviour.

---

## Checked and deliberately not flagged

- `memory/repository.ts` as a facade over `repository/{item,search}.repo.ts` — this is
  the documented convention (`reviews/repository.ts`), and the split is justified on
  axis of change (schema-shaped writes vs. pgvector tuning), exactly as
  `pitfalls-and-tradeoffs.md` describes. Not premature.
- `helpers.ts` / `constants.ts` in both modules — matches `settings/`, `blast/`,
  `brief/`; pure and unit-testable, no I/O.
- Both services taking the whole `Container` — documented, accepted trade-off.
- `DigestRow` / `MemoryRow` as `$inferSelect` DTOs — accepted schema-first compromise.
- `memory` module overall: `routes.ts` is parse → delegate → shape, `service.ts`
  touches no Drizzle, adapters arrive only through the container. Apart from finding 8
  it is a correct example of the layering.
