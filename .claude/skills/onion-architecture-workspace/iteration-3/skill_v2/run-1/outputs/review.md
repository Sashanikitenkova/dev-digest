# PR review — `digests` + `memory` modules, `reviewer-core/review/summarize.ts`

Reviewed against `.claude/skills/onion-architecture` (SKILL.md + all five guides),
`server/src/platform/container.ts`, `server/src/vendor/shared/adapters.ts`,
`server/src/db/rows.ts`, `server/src/modules/index.ts`, `reviewer-core/CLAUDE.md`
and `TESTING.md`.

**Verdict: request changes.** Nine blocking problems, several of which are
Dependency-Rule violations of the kind the repo has zero precedent for. The
`memory` module is close to mergeable; `digests` and `summarize.ts` are not.

---

## Blocking

### 1. `reviewer-core/src/review/summarize.ts:5,39-41` — the core constructs its own LLM provider and reads an API key

```ts
const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error('OPENROUTER_API_KEY is not configured');
const llm = new OpenRouterProvider(key, { timeoutMs: 60_000 });
```

This is the single worst violation in the PR. `reviewer-core/src/index.ts` states
the contract: "the only side effect is an LLM call through an INJECTED
LLMProvider." `guides/reviewer-core-llm-port.md` names this exact anti-pattern —
`OpenRouterProvider` may *live* in the package, but it is constructed **only at a
consumer's composition root** (`container.ts`'s `buildLlm()`), never inside
`prompt.ts`, `grounding.ts`, or `review/*`. There are two composition roots
(studio server and the CI agent-runner); this file hardcodes one of them.

It also breaks the repo-wide secrets convention (root `CLAUDE.md`): keys live in
`~/.devdigest/secrets.json` behind `SecretsProvider`, not `process.env`. Reading
the env var here means the studio path silently ignores the key the user
configured through the UI, and `container.reset()`'s cache invalidation on key
change does nothing for this call path. The `PriceBook`-injected `estimateCost`
that `buildLlm()` wires in is also lost, so these calls report no cost.

**Fix:** add `llm: LLMProvider` to `SummarizeInput` and use it. Delete the
`OpenRouterProvider` import, the env read, and the throw. Callers pass
`await container.llm('openrouter')`.

### 2. `reviewer-core/src/review/summarize.ts:62-66` — findings returned without `groundFindings()`

```ts
return {
  headline: result.data.headline,
  findings: result.data.findings,
```

Raw model output is handed straight back as `Finding[]`. Grounding is a
non-negotiable domain invariant — root `CLAUDE.md` ("every finding must cite a
real diff line or it's dropped"), `reviewer-core/CLAUDE.md` ("never bypass
`groundFindings()`"), and `guides/reviewer-core-llm-port.md`'s explicit "bad"
example, which is almost verbatim this code. `input.diff` is already in hand, so
there is no excuse.

Making it worse: `SummaryPayload` uses `z.array(z.custom<Finding>())`, which
validates nothing at all. Every field of every finding is unchecked, so
hallucinated file paths and line numbers pass straight through to the PR page.

**Fix:** pipe through `groundFindings(result.data.findings, input.diff)` and
return `.kept`; surface the drop count the way `review/run.ts` does. Replace
`z.custom<Finding>()` with the real `Finding` schema.

### 3. `reviewer-core/src/review/summarize.ts:1,43-46` — filesystem access inside `reviewer-core`

```ts
import { readFile } from 'node:fs/promises';
...
for (const path of input.skillPaths ?? []) {
  skills.push(await readFile(path, 'utf8'));
}
```

`reviewer-core` has "NO database, GitHub, or filesystem access" by design. The
skill's Quick Reference covers this case by name: "Give `reviewer-core` a new
capability that needs a DB row or a file read → resolve it to a plain
string/object in the caller (`server`), pass it in as data." `ReviewInput`
already does exactly that ("Resolved skill bodies (NOT slugs)"). This also makes
the function untestable without a real filesystem, and turns caller-supplied
paths into an arbitrary-file-read primitive.

**Fix:** replace `skillPaths?: string[]` with `skills?: string[]` (resolved
bodies), drop the `node:fs/promises` import. The server resolves bodies via
`container.skillsRepo`, as `reviews` already does.

### 4. `server/src/modules/digests/service.ts:2,64` — service imports and constructs a concrete adapter

```ts
import { OctokitGitHubClient } from '../../adapters/github/octokit.js';
...
const github = new OctokitGitHubClient(process.env.GITHUB_TOKEN ?? '');
```

`platform/container.ts` is the only file permitted to import `adapters/*` client
classes and wire them to ports (`guides/layer-model.md`: "If you find yourself
importing from `server/src/adapters/*` anywhere outside `container.ts`, that's a
Dependency Rule violation"). `guides/fastify-routing-and-di.md`'s "bad" example
is this line.

Three concrete consequences, not just a style point:
- **`ContainerOverrides.github` is bypassed**, so this code path can never be
  mocked — see finding 9, where the new integration test would hit live GitHub.
- **Secrets are re-implemented ad hoc** against `process.env`, ignoring
  `SecretsProvider`/`~/.devdigest/secrets.json`.
- **`?? ''` silently degrades to an unauthenticated Octokit**, so a missing
  token surfaces as a confusing 401/rate-limit deep in the loop instead of the
  `ConfigError('GITHUB_TOKEN is not configured')` `container.github()` raises.

Note this is *not* comparable to the existing `modules/context/helpers.ts`
importing `approxTokens` from `adapters/tokenizer` — those are pure functions.
This is a network client constructed with a credential.

**Fix:** `const github = await this.container.github();`

### 5. `server/src/modules/digests/service.ts:6,83` — reaches into another module's aggregate repository file

```ts
import { nearest } from '../memory/repository/search.repo.js';
...
const related = await nearest(this.container.db, workspaceId, queryVector, { ... });
```

`guides/drizzle-repository-pattern.md` is explicit: "Do not import
`../<module>/repository.js` or, worse, `../<module>/repository/<aggregate>.repo.ts`."
The tree currently has **zero** cross-module imports of an aggregate `.repo.ts`
file; this would be the first. It also defeats the `MemoryRepository` facade
that this same PR introduces, and skips `MemoryService.search`'s two behaviours
— `markUsed` recency tracking and `dedupeByContent` — so digests will happily
print the same remembered sentence four times.

**Fix:** `new MemoryService(this.container).search(workspaceId, text, { limit: RELATED_MEMORY_LIMIT })`,
or expose a `container.memoryRepo` getter alongside `agentsRepo`/`reviewRepo`/`skillsRepo`
if raw vector access is genuinely needed. Cross-module *data* comes from the
owning module's service or a container getter — never its folder.

### 6. `server/src/modules/digests/service.ts:1,5,32-62` — raw Drizzle in a service that already has a repository

```ts
import * as t from '../../db/schema.js';
...
const merged = await this.container.db.select({ ... }).from(t.pullRequests).where(...)
const [repoRow] = await this.container.db.select({ ... }).from(t.repos)...
```

"All Drizzle access for a domain lives in `modules/<name>/repository.ts`.
Services never import `db/schema.js` directly." The module ships a
`DigestsRepository` and then goes around it for two of its three queries, so the
"ONLY layer touching the DB" invariant is broken inside a single module. (The
`settings`/`pulls` routes that touch `db/schema.js` are modules with *no*
repository — a different, proportionality-driven case; it does not license this.)

Note the PR queries `pullRequests` and `repos`, tables owned by the `pulls`/`repos`
domains, so pushing them into `DigestsRepository` is not automatically right
either.

**Fix:** take merged PRs and the repo ref from `PullsService`/`ReposService`
(cross-module *services* are fine and normal here — `brief/service.ts` composes
four of them), or add narrow read methods to `DigestsRepository`. Either way, no
`db/schema.js` import in `service.ts`.

### 7. `server/src/modules/digests/routes.ts:6,28,36-47,52` — route holds a repository and owns the business logic

```ts
const repo = new DigestsRepository(app.container.db);
...
const periodEnd = new Date();
const periodStart = new Date(periodEnd.getTime() - req.body.periodDays * 24 * 60 * 60 * 1000);
const existing = await repo.findByPeriod(workspaceId, periodStart, periodEnd);
if (existing && !req.body.regenerate) return { digest: existing, cached: true };
if (existing) await repo.deleteById(workspaceId, existing.id);
const digest = await service.build(...);
```

Routes are presentation-only: Zod validate → call service → shape response. This
handler computes the domain window, runs the cache lookup, decides regenerate-vs-reuse,
and issues a delete — all domain decisions — and `GET /digests` (line 52) calls
`repo.listRecent` with no service in the path at all. No other `routes.ts` in
the tree constructs a repository (verified: `grep "new .*Repository(" src/modules/*/routes.ts`
returns nothing). It also means two `DigestsRepository` instances exist per
request, and the service has no idea a cache decision was made above it.

Secondary: the read-then-delete-then-rebuild sequence is non-atomic — two
concurrent `POST /digests` both miss the cache and both bill a full model run.

**Fix:** one call —
`const { digest, cached } = await service.generate(workspaceId, req.body.periodDays, req.body.regenerate)` —
with the window math, lookup, delete and rebuild inside `DigestsService`, and a
`service.listRecent()` for the GET. Consider a transaction or unique constraint
on `(workspaceId, periodStart, periodEnd)` for the race.

### 8. `server/src/modules/memory/repository/item.repo.ts:4` and `search.repo.ts:4` — aggregates import back from their own facade

```ts
import type { InsertMemory, MemoryRow } from '../repository.js';   // item.repo.ts:4
import type { MemoryRow, NearestOptions } from '../repository.js'; // search.repo.ts:4
```

while `repository.ts:13-14` imports both files back. That is a cycle between a
class and its own parts. `guides/drizzle-repository-pattern.md` §"Types flow
down, not back up" calls this out precisely, including why it survives review:
type-only imports are erased, so it compiles. `reviews/repository/{review,run,pull}.repo.ts`
— the pattern this module is modelled on — take their row types from
`db/rows.ts` instead. The cost is that neither aggregate can be tested or reused
without dragging the facade in.

**Fix:** move `MemoryRow` to `server/src/db/rows.ts` (see finding 11) and
`InsertMemory`/`NearestOptions` to a module-local `memory/types.ts`; have the
facade and both aggregates import from there. Dependency then runs one way:
facade → aggregates → types.

### 9. `server/test/digests-service.test.ts` — wrong filename, and it cannot actually pass

Two problems in one file:

- **Line 2** imports `startPg` from `./helpers/pg.js` and boots a real Postgres,
  but the file is named `*.test.ts`. `TESTING.md`: "A DB-backed test that imports
  `test/helpers/pg.ts` must use the `.it.test.ts` suffix." The unit lane runs
  `vitest run --exclude '**/*.it.test.ts'`, so as named this test lands in the
  Docker-free lane and drags a container into it. The skill's checklist says the
  same ("real-Postgres → `*.it.test.ts`"). Every sibling — `reviews.it.test.ts`,
  `blast.it.test.ts`, `skills.it.test.ts` — follows the convention.
  **Fix:** rename to `server/test/digests.it.test.ts`.
- **Lines 30-34** override `llm`, `embedder` and `git` but not `github` — because
  finding 4 means there is nothing to override. `DigestsService.build` will
  construct a real `OctokitGitHubClient` and call `api.github.com` once per
  merged PR. In CI (no `GITHUB_TOKEN`) that is an unauthenticated 401/rate-limit;
  locally it is a live network call from a "hermetic" suite. This is the
  concrete testability damage that makes finding 4 blocking rather than stylistic.
  **Fix:** falls out of finding 4 — then add `github: new MockGitHubClient()`
  (already exported from `src/adapters/mocks.ts:130`).

### 10. `server/src/modules/index.ts` — neither new module is registered

The PR adds `modules/digests/routes.ts` and `modules/memory/routes.ts` but no
entry in the static registry. `modules/index.ts:23-26` states the rule: "create
`modules/<name>/routes.ts` exporting a default Fastify plugin, then add one
import + one entry below," registered statically so the same path works under
tsx, the bundler and vitest. Without it both modules are dead code and the new
test's `app.inject({ url: '/digests' })` returns 404.

**Fix:** add `import digests from './digests/routes.js';` /
`import memory from './memory/routes.js';` and the two entries.

### 11. `reviewer-core/src/review/summarize.ts:48-60` — does not compile against the current APIs

Two mismatches against the real signatures:

- `assemblePrompt({ systemPrompt, diff, skills, task })` — `PromptParts`
  (`reviewer-core/src/prompt.ts:200-202`) declares the field as `system`, not
  `systemPrompt`. And `AssembledPrompt` (`prompt.ts:247-250`) returns
  `{ messages, assembly }`; there is no `.system` / `.user` to destructure at
  lines 56-58.
- `llm.completeStructured({ model, system, user, schema })` — `StructuredRequest`
  (`vendor/shared/adapters.ts:55-70`) requires `messages: ChatMessage[]` and
  `schemaName: string`; `system`/`user` are not fields. Compare
  `review/run.ts:193-200`.

Since `reviewer-core`'s `npm run typecheck` *is* its build, this fails the build
today. Worth flagging on its own because it suggests the file was written
against a remembered API rather than the current one — please re-check the rest
of the flow after fixing.

---

## Should fix before merge

### 12. `server/src/modules/digests/helpers.ts:1` — cross-module row type from another module's repository

```ts
import type { MemoryRow } from '../memory/repository.js';
```

Importing another module's `repository.ts` for a row shape is exactly what
`server/src/db/rows.ts` exists to prevent ("so cross-cutting consumers can
reference a row shape WITHOUT importing another module's data layer"). The tree
has exactly one such import today (`reviews/run-executor.ts` taking `PrIntentRow`
from `intent/repository.js`), described in the guide as "a lone exception that
should have come from `db/rows.ts`, not a licence."

**Fix:** add `export type MemoryRow = typeof t.memory.$inferSelect;` to
`db/rows.ts` and import from there. Or better, since `renderMemoryLine` only
reads `.content`, type the parameter structurally (`{ content: string }`) as
`memory/helpers.ts` already does with its `HasContent` interface — no
cross-module type dependency at all.

### 13. `db/rows.ts` — new row types are declared module-locally instead

`digests/repository.ts:5` (`DigestRow`) and `memory/repository.ts:16` (`MemoryRow`)
both define their rows in the module. `db/rows.ts` documents the convention:
"Each owning repository re-exports its row from here to keep its public type API
unchanged." Findings 8 and 12 both dissolve once this is done.

**Fix:** declare `DigestRow` and `MemoryRow` in `db/rows.ts`; re-export from each
`repository.ts`.

### 14. `server/src/modules/digests/service.ts:57-69` — assumes every merged PR is in one repo

```ts
const [repoRow] = await this.container.db.select(...).where(eq(t.repos.id, merged[0]!.repoId));
...
for (const pr of merged) {
  const detail = await github.getPullRequest({ owner: repoRow.owner, name: repoRow.name }, pr.number);
```

The repo ref is resolved once from `merged[0]` and then used for every PR. A
workspace with more than one imported repo — the normal case — will fetch PR
`#42` from the wrong repository, or 404, and silently attribute another repo's
description to this PR's summary. Not an architectural issue; a straightforward
correctness bug.

**Fix:** resolve repo refs for the whole set (one query keyed by `repoId`) and
look up per PR.

### 15. `server/src/modules/digests/service.ts:80-81` — unguarded `container.embedder()`

`container.embedder()` throws `ConfigError` when `config.embeddingsEnabled` is
false, and its own doc comment records the contract: "All callers wrap this in
try/catch and degrade gracefully." `MemoryService.embedOrNull` (`memory/service.ts:57-65`)
does. This one does not — so on any workspace without embeddings the entire
digest 500s at the *end*, after paying for up to 40 model calls. The related-memory
tail is decoration; it must not take the digest down.

**Fix:** wrap lines 80-89 in try/catch (or reuse `MemoryService.search`, which
already degrades) and emit the digest without the memory tail.

### 16. `server/src/modules/digests/repository.ts:24-40` — `findByPeriod` does not do what its doc comment says

The doc comment (lines 17-19) says periods are "matched on their exact
boundaries rather than by overlap." The query does
`gte(periodStart, periodStart) AND lte(periodEnd, periodEnd)` — window
*containment*, the opposite of exact. Since `routes.ts:33` sets
`periodEnd = new Date()` on every request, an exact match could never occur
anyway, so the cache as written will keep matching progressively older digests
and returning them as fresh. There is also no `orderBy` or `limit(1)` on a query
destructured as `[row]`, so which digest you get is whatever Postgres returns
first.

**Fix:** decide which semantic you want. If exact: `eq` on both boundaries, and
have the service snap the window to day boundaries so it is reproducible. If
most-recent-covering: say so in the comment and add
`.orderBy(desc(t.digests.periodEnd)).limit(1)`.

### 17. `server/src/modules/digests/service.ts:68-78` — serial N+1 inside a request handler

Up to `MAX_PRS_PER_DIGEST` (40) sequential GitHub round-trips *plus* 40
sequential LLM calls, all inside an HTTP handler with no batching, concurrency
limit or timeout. That is minutes of wall-clock under an open connection, and a
client retry re-bills the whole thing (see the race in finding 7).

**Fix:** bound the concurrency, or run it through `container.jobs` (`JobRunner`)
and return a job id, following how the longer-running flows in this repo behave.

---

## Non-blocking notes

18. **`reviewer-core/src/index.ts`** — `summarizeReview` is not exported. If the
    server is meant to call it, add it to the barrel with the other entry points;
    if it is internal, say so in the doc comment.
19. **`reviewer-core/src/review/summarize.ts:7`** — `SUMMARY_MODEL` is hardcoded
    in the core. `reviewPullRequest` takes `model` from `ReviewInput`; model
    choice is a caller concern (the studio lets users pick one). Move it to
    `SummarizeInput`, defaulting if you like.
20. **`server/src/modules/digests/service.ts:53-54`** — an empty period throws
    `NotFoundError`, so a quiet week is a 404. "No PRs merged" is a valid,
    expected result; prefer an empty digest or a 200 with an explicit empty
    marker.
21. **`server/src/modules/memory/service.ts:57-65`** — `embedOrNull`'s bare
    `catch {}` swallows every failure identically, so a genuine embedder outage
    is indistinguishable from "embeddings disabled" and search just silently
    returns `[]`. The degrade behaviour is right and matches `repo-intel`'s
    documented convention; add a `req.log.warn` (or `console.warn`) so the
    silence is observable.
22. **No test for `memory`** — the PR adds a `digests` test only. `MemoryService`
    has real branching worth covering (the `embedOrNull` null path, `forget`'s
    not-found throw, `dedupeByContent`). `dedupeByContent` and `renderDigestMarkdown`
    are pure and belong in a plain `memory-helpers.test.ts` / `digests-helpers.test.ts`
    in the unit lane, mirroring `blast-helpers.test.ts`.
23. **`server/src/modules/digests/routes.ts:30`** — `POST /digests` creates a
    resource and returns 200. `memory/routes.ts:39` correctly sets 201. Minor
    inconsistency.

---

## Checked and clean — do not "fix" these

- **`memory/repository.ts`'s facade over `repository/{item,search}.repo.ts`.**
  This is the documented convention (`reviews/repository.ts` is the canonical
  example), and the module's doc comment gives the right justification — an
  axis-of-change split (schema-shaped writes vs. pgvector tuning), which
  `guides/pitfalls-and-tradeoffs.md` names as legitimate even over one table.
  Not premature, not needless indirection, do not propose collapsing it. Aside
  from the import direction in finding 8, this is the best-structured part of
  the PR.
- **`MemoryService`/`DigestsService` taking the whole `Container`.** An accepted,
  documented trade-off in this codebase, not an interface-segregation defect.
- **Row types doubling as DTOs** (`DigestRow`, `MemoryRow` as `$inferSelect`).
  Deliberate. The issue in finding 13 is *where* they are declared, not that
  they are schema-shaped.
- **`memory/routes.ts`.** Textbook presentation-only: Zod schemas, `getContext`,
  one service call each, response shaping, no repository in sight. Use it as the
  model for rewriting `digests/routes.ts`.
- **`memory/helpers.ts` and `digests/constants.ts`.** Pure, dependency-free,
  properly placed. `helpers.ts`'s structural `HasContent` constraint is the right
  instinct — apply it in `digests/helpers.ts` too (finding 12).
- **Schema.** Both `memory` (`db/schema/knowledge.ts:8`) and `digests`
  (`db/schema/ops.ts:41`) already exist; no migration is needed. Worth confirming
  that `digests.periodStart`/`periodEnd`/`bodyMd` being nullable in the schema is
  intended, since `DigestsRepository.insert` always supplies all three.
