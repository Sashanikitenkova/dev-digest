# PR Review — `digests` + `memory` modules, `reviewer-core/review/summarize.ts`

Reviewed against `.claude/skills/onion-architecture` (SKILL.md + all five guides),
`server/CLAUDE.md`, `reviewer-core/CLAUDE.md`, `TESTING.md`, and `server/INSIGHTS.md`.

**Verdict: request changes.** The `memory` module is close to mergeable — its
routes → service → facade-repository shape follows the house convention, and its
facade-over-`repository/<aggregate>.repo.ts` split is the documented pattern, not
a finding. The `digests` module and `reviewer-core/src/review/summarize.ts` both
break the Dependency Rule in several places, and neither new module is registered,
so neither is actually reachable. Several findings are also hard compile errors.

Findings are ordered most-important-first. C = blocking, H = high, M = medium,
L = low / non-blocking note.

---

## C1 — `summarize.ts` constructs its own LLM provider and reads an API key

**File:** `reviewer-core/src/review/summarize.ts:5, 39-41`

```ts
import { OpenRouterProvider } from '../llm/openrouter.js';
...
const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error('OPENROUTER_API_KEY is not configured');
const llm = new OpenRouterProvider(key, { timeoutMs: 60_000 });
```

This is the exact "Bad" example in `guides/reviewer-core-llm-port.md` §Good vs bad
①. `reviewer-core/src/index.ts`'s own doc comment is the contract: *"the only side
effect is an LLM call through an INJECTED LLMProvider."* `OpenRouterProvider` may
*live* in the package, but it is only ever *constructed* at a composition root —
`server/src/platform/container.ts:193` (`buildLlm`) for the studio, and the CI
agent-runner for the other consumer. A new engine file constructing it internally
collapses that boundary: `summarizeReview()` becomes untestable without a live key
and unusable from the CI runner's own wiring.

Reading `process.env.OPENROUTER_API_KEY` is a second, independent violation: the
repo resolves secrets through `SecretsProvider` (`~/.devdigest/secrets.json`, mode
0600) per root `CLAUDE.md` and `server/CLAUDE.md` — never `process.env` in feature
code.

**Fix:** add `llm: LLMProvider` to `SummarizeInput` and take it as a parameter;
delete the `OpenRouterProvider` import, the env read and the `new`. Callers pass
`await container.llm('openrouter')` (studio) or the runner's own provider (CI).

---

## C2 — `summarize.ts` reads the filesystem

**File:** `reviewer-core/src/review/summarize.ts:1, 20, 43-46`

```ts
import { readFile } from 'node:fs/promises';
...
for (const path of input.skillPaths ?? []) {
  skills.push(await readFile(path, 'utf8'));
}
```

`reviewer-core` has zero filesystem access by design (`index.ts` doc comment,
`reviewer-core/CLAUDE.md`, and the SKILL.md quick-reference row: *"Resolve it to a
plain string/object in the caller (`server`), pass it in as data"*). `ReviewInput`
already models this correctly — its skills slot documents "Resolved skill bodies
(NOT slugs)". `skillPaths: string[]` reintroduces a host-filesystem dependency into
the pure core, and the two consumers resolve skills from different places (the
server from `skillsRepo`, the CI runner from disk), so absolute paths are not even
a portable contract.

**Fix:** replace `skillPaths?: string[]` with `skills?: string[]` (already-resolved
bodies, matching `PromptParts.skills`), drop the `node:fs/promises` import, and
resolve the bodies in the caller.

---

## C3 — `summarize.ts` returns LLM findings without grounding them

**File:** `reviewer-core/src/review/summarize.ts:55-66`

```ts
const result = await llm.completeStructured({ ... });
return { headline: result.data.headline, findings: result.data.findings, ... };
```

Grounding is a non-negotiable domain invariant, not optional post-processing —
root `CLAUDE.md` ("every finding must cite a real diff line or it's dropped"),
`reviewer-core/CLAUDE.md` ("never bypass `groundFindings()`"), SKILL.md's checklist,
and `guides/reviewer-core-llm-port.md` §Good vs bad ②, which describes this precise
shape as the bad case. `review/run.ts:216` shows the required shape
(`groundFindings(merged.findings, input.diff)`). These findings are destined for
"above the fold on the PR page", i.e. exactly where a hallucinated line citation
does the most damage.

**Fix:** pipe the findings through `groundFindings(result.data.findings, input.diff)`
and return only `kept`; if a score is ever added to `SummarizeOutcome`, recompute it
from the survivors rather than trusting the model.

---

## C4 — `DigestsService` constructs `OctokitGitHubClient` itself

**File:** `server/src/modules/digests/service.ts:2, 64`

```ts
import { OctokitGitHubClient } from '../../adapters/github/octokit.js';
...
const github = new OctokitGitHubClient(process.env.GITHUB_TOKEN ?? '');
```

Only `platform/container.ts` may import from `adapters/*`
(`guides/layer-model.md`: *"If you find yourself importing from
`server/src/adapters/*` anywhere outside `container.ts`, that's a Dependency Rule
violation"*; `guides/fastify-routing-and-di.md` §Composition-root discipline). The
container already has this exact getter, including the secret lookup
(`container.ts:161-168`).

Three concrete costs, not just a style point:
- `ContainerOverrides.github` is bypassed, so no test can ever mock GitHub for this
  path — see F11/F12 below, where the accompanying test would make live, billed
  GitHub calls.
- The `SecretsProvider` chain is duplicated ad hoc; `process.env.GITHUB_TOKEN` is
  explicitly not where this repo keeps tokens.
- `?? ''` silently constructs an unauthenticated client instead of failing, where
  the container raises a clear `ConfigError('GITHUB_TOKEN is not configured')`.

**Fix:** `const github = await this.container.github();` and delete the import.

---

## C5 — `DigestsService` queries Drizzle directly

**File:** `server/src/modules/digests/service.ts:1, 5, 32-51, 57-60`

```ts
import * as t from '../../db/schema.js';
...
const merged = await this.container.db.select({ ... }).from(t.pullRequests)...
const [repoRow] = await this.container.db.select({ ... }).from(t.repos)...
```

The repository is the only layer that touches the DB for its domain
(`guides/drizzle-repository-pattern.md` §"Repository owns all Drizzle access",
quoting `reviews/repository.ts`'s own invariant; SKILL.md checklist: *"Services
never import `db/schema.js` directly"*). This is the guide's literal "Bad" example
①. The irony is that `DigestsRepository` already exists two files away and the
service holds an instance of it.

**Fix:** move both queries onto `DigestsRepository` as typed methods —
e.g. `listMergedInPeriod(workspaceId, periodStart, periodEnd, limit)` and a repo
lookup — and drop the `db/schema.js` import from the service. (The `repos` lookup
would be better still as a call to the repos module's service; see C6's rule.)

---

## C6 — `DigestsService` imports another module's aggregate repo file

**File:** `server/src/modules/digests/service.ts:6, 83`

```ts
import { nearest } from '../memory/repository/search.repo.js';
...
const related = await nearest(this.container.db, workspaceId, queryVector, { limit: RELATED_MEMORY_LIMIT });
```

This breaks two separate rules at once:

1. **Cross-module data-layer import.** SKILL.md: *"never another module's data
   layer… cross-module data comes from that module's service or a `container.*Repo`
   getter."* `guides/drizzle-repository-pattern.md` notes the tree currently has
   **zero** cross-module imports of an aggregate `.repo.ts` — this would be the
   first.
2. **Reaching past the facade.** `guides/drizzle-repository-pattern.md` §Good vs bad
   ② names "a caller importing `repository/review.repo.ts`'s functions directly
   instead of going through the facade" as the inverse mistake, because it defeats
   the stable composed API.

It also duplicates logic `MemoryService` already owns: the digests service
hand-rolls embed-then-search (lines 80-89), while `MemoryService.search()` does the
same thing plus `embedOrNull` degradation, `markUsed` and `dedupeByContent`.

**Fix:** `new MemoryService(this.container).search(workspaceId, text, { limit: RELATED_MEMORY_LIMIT })`
— importing another module's *service* is normal composition here. Delete the
embedder block (lines 80-85) with it.

---

## C7 — `digests/routes.ts` owns business logic and calls the repository directly

**File:** `server/src/modules/digests/routes.ts:6, 28, 33-44, 52`

```ts
const repo = new DigestsRepository(app.container.db);
...
const periodEnd = new Date();
const periodStart = new Date(periodEnd.getTime() - req.body.periodDays * 24 * 60 * 60 * 1000);
const existing = await repo.findByPeriod(workspaceId, periodStart, periodEnd);
if (existing && !req.body.regenerate) return { digest: existing, cached: true };
if (existing) await repo.deleteById(workspaceId, existing.id);
const digest = await service.build(workspaceId, periodStart, periodEnd);
```

Routes are presentation-only: Zod validation → service call(s) → response shaping
(`guides/fastify-routing-and-di.md` §"Routes are presentation-only"; SKILL.md
checklist). Here the handler instantiates the data layer *and* owns the entire
cache-or-rebuild decision — window arithmetic, the cached short-circuit, the
delete-then-rebuild branch. That is the guide's "Bad" example ② almost verbatim
("inline `if (…) { } else { }` branching plus direct `repo.insertReview(...)`
calls"), and it means the reuse rule the module docstring advertises can only be
tested by booting a Fastify instance.

Note also that this delete-then-insert is not transactional and mirrors a known
hazard — `server/INSIGHTS.md` 2026-08-28, "A transaction does NOT make
delete-then-insert safe against a concurrent write of the same owner".

**Fix:** one service method, e.g.
`service.generate(workspaceId, { periodDays, regenerate }): Promise<{ digest: DigestRow; cached: boolean }>`,
owning window computation, the lookup, the delete and the build; and
`service.list(workspaceId, limit)` for `GET`. Remove the `DigestsRepository` import
and the `repo` local from `routes.ts` entirely.

---

## C8 — Neither new module is registered; both are dead code

**File:** `server/src/modules/index.ts` (unchanged by this PR)

SKILL.md checklist: *"New module = `routes.ts` + `service.ts` + `repository.ts` …
registered once in `modules/index.ts` — no bypassing the static registry."* The
registry lists 16 modules and neither `digests` nor `memory` is among them, and the
PR does not touch the file. Registration is static by deliberate design (the file's
own comment explains why: portability across tsx / the bundler / vitest). As it
stands, every route in this PR 404s, and the accompanying integration test's
`app.inject({ url: '/digests' })` cannot pass.

**Fix:** add `import digests from './digests/routes.js';` and
`import memory from './memory/routes.js';` plus their two entries in the `modules`
record.

---

## H9 — `memory` aggregate files import types back from the facade (cycle)

**Files:** `server/src/modules/memory/repository/item.repo.ts:4` and
`server/src/modules/memory/repository/search.repo.ts:4`

```ts
import type { InsertMemory, MemoryRow } from '../repository.js';   // item.repo.ts
import type { MemoryRow, NearestOptions } from '../repository.js'; // search.repo.ts
```

while `repository.ts:13-14` imports both files back. `guides/drizzle-repository-pattern.md`
§"Types flow down, not back up" calls this out precisely, including why it survives
review: *"It usually still compiles — type-only imports are erased — which is
exactly why it survives review."* `reviews/repository/{review,run,pull}.repo.ts`
take their row types from `db/rows.ts` instead, so the dependency runs one way:
facade → aggregates → types.

To be explicit: **the facade-over-aggregate split itself is correct** and matches
`reviews/repository.ts`; the axis-of-change rationale in the docstring (schema-shaped
writes vs. pgvector tuning) is exactly the justification
`guides/pitfalls-and-tradeoffs.md` endorses. Only the import direction is wrong.

**Fix:** put `MemoryRow` in `server/src/db/rows.ts` (it is needed cross-module —
see H10) and `InsertMemory`/`NearestOptions` in a module-local
`modules/memory/types.ts`; have `repository.ts` and both aggregate files import
from there. `repository.ts` can re-export `MemoryRow` to keep its public type API
unchanged, the way `db/rows.ts` describes.

---

## H10 — `digests/helpers.ts` imports a row type from the memory module's data layer

**File:** `server/src/modules/digests/helpers.ts:1`

```ts
import type { MemoryRow } from '../memory/repository.js';
```

SKILL.md checklist: *"Cross-module row types come from `db/rows.ts`."* `db/rows.ts`
exists for exactly this and says so in its own doc comment ("so cross-cutting
consumers can reference a row shape WITHOUT importing another module's data
layer"). The guide notes there is currently exactly one such import in the whole
tree and calls it "a lone exception that should have come from `db/rows.ts`, not a
licence" — this would be the second.

**Fix:** add `export type MemoryRow = typeof t.memory.$inferSelect;` to
`server/src/db/rows.ts` and import from there. (`renderMemoryLine` only reads
`item.content`, so a structural `{ content: string }` parameter would also work and
couples nothing.)

---

## H11 — DB-backed test is missing the `.it.test.ts` suffix

**File:** `server/test/digests-service.test.ts` (whole file; `:2-3, 15, 27`)

The test calls `startPg()`, `runMigrations`, `seed()` and `buildApp()` against a
real Postgres container, but is named `*.test.ts`. That places it in the **unit**
lane, which runs as `vitest run --exclude '**/*.it.test.ts'` and is supposed to be
hermetic and Docker-free. `server/CLAUDE.md` states it as a hard rule: *"A DB-backed
test **must** be named `*.it.test.ts` or the unit/integration split silently
miscategorizes it"*; `TESTING.md:86-89` and SKILL.md's checklist ("real-Postgres →
`*.it.test.ts`") say the same. Every sibling — `reviews.it.test.ts`,
`skills.it.test.ts`, `brief.it.test.ts` — follows it.

**Fix:** rename to `server/test/digests.it.test.ts`.

---

## H12 — The test injects only some providers, so it hits the real network

**File:** `server/test/digests-service.test.ts:30-34`

```ts
overrides: {
  llm: { openrouter: new MockLLMProvider('openrouter') },
  embedder: new MockEmbedder(),
  git: new MockGitClient(),
},
```

No `github` override. Today that does not even matter — C4's
`new OctokitGitHubClient(process.env.GITHUB_TOKEN ?? '')` ignores overrides
entirely, so this test makes live GitHub requests for all three seeded PRs. Once C4
is fixed, the missing override becomes the failure mode instead:
`container.github()` falls through to `LocalSecretsProvider`, finds the developer's
real `~/.devdigest/secrets.json` token, and the test silently goes live.

This is a documented, already-paid-for lesson — `server/INSIGHTS.md` 2026-08-11,
"An integration test that injects only SOME providers silently hits the real
network": it did not fail loudly, it just got slow and produced a misleading
assertion failure.

**Fix:** add `github: new MockGitHubClient()` to `overrides`, and inject every
provider the digest path can reach.

---

## H13 — `new MockLLMProvider('openrouter')` does not compile

**File:** `server/test/digests-service.test.ts:31`

`MockLLMProvider`'s constructor accepts only `'openai' | 'anthropic'`
(`server/src/adapters/mocks.ts:58-63`). This is a known trap with a recorded
resolution — `server/INSIGHTS.md` 2026-08-22: `Container.llm(id)` resolves an
override **by key** and never inspects `provider.id`, so the `openrouter` slot
takes an openai-flavoured mock.

**Fix:** `llm: { openrouter: new MockLLMProvider('openai') }`. Do not widen the
shared mock.

---

## H14 — The test uses `pg.db`, which does not exist

**File:** `server/test/digests-service.test.ts:26-29, 44-47, 48, 76`

`PgFixture` exposes `{ container, handle, url, stop }` — the Drizzle client is
`pg.handle.db` (`server/test/helpers/pg.ts:13-18`). Compare `skills.it.test.ts:31`
(`await seed(pg.handle.db)`). Every `pg.db` reference here fails to compile.

**Fix:** `pg.handle.db` throughout (`seed`, `db: pg.handle.db`, and the three query
sites).

---

## H15 — `summarize.ts` does not match the APIs it calls

**File:** `reviewer-core/src/review/summarize.ts:9-12, 48-60`

Independent of the layering findings, this file cannot compile:

- `assemblePrompt` takes `PromptParts` with `system: string` (not `systemPrompt`)
  and `diff: string` (not `UnifiedDiff`) — `prompt.ts:200-245`.
- It returns `AssembledPrompt = { messages, assembly }` (`prompt.ts:247-250`); there
  is no `prompt.system` / `prompt.user`.
- `StructuredRequest` requires `messages: ChatMessage[]` and `schemaName: string`;
  it has no `system` / `user` fields — `vendor/shared/adapters.ts:55-70`. Compare
  the correct call at `review/run.ts:193-200`.
- `z.custom<Finding>()` (line 11) performs **no runtime validation** — it accepts
  any value and only casts the type. The real `Finding` Zod schema already exists at
  `vendor/shared/contracts/findings.ts:47`; use it so the structured-output
  parse-with-repair loop actually validates, and so grounding (C3) receives
  well-formed findings.

**Fix:** mirror `review/run.ts`'s call shape and import the shared `Finding` schema.

---

## M16 — `container.embedder()` is called unguarded

**File:** `server/src/modules/digests/service.ts:80-85`

`Container.embedder()` throws `ConfigError` when `embeddingsEnabled` is false, and
its comment states the contract: *"All callers wrap this in try/catch and degrade
gracefully"* (`container.ts:203-211`). `MemoryService.embedOrNull` (memory
`service.ts:57-65`) is the correct local example. As written, an entire digest build
fails on any workspace without embeddings — for a section the module treats as
optional garnish.

**Fix:** this block disappears if C6 is fixed by delegating to `MemoryService.search()`,
which already degrades to `[]`. Otherwise wrap in try/catch.

---

## M17 — The merged-PR query is wrong in two ways

**File:** `server/src/modules/digests/service.ts:43-51, 57-60, 69`

- The window has no upper bound: `gte(t.pullRequests.updatedAt, periodStart)` with
  no `lte(..., periodEnd)`, so `periodEnd` is accepted, stored on the row, rendered
  in the heading, and then never applied. Any future-dated or later-updated row
  leaks into a historical digest.
- `updatedAt` is not a merge timestamp. A PR merged six months ago and touched
  yesterday appears in this week's digest.
- The repo is resolved once from `merged[0]!.repoId` (line 60) and then used as the
  `RepoRef` for **every** PR's `getPullRequest` call (line 69). A workspace with more
  than one repo fetches PR #N from the wrong repository — returning another repo's PR
  body, or 404-ing mid-build.

**Fix:** bound the window at both ends, filter on the merge timestamp, and group the
PRs by `repoId` (or join `repos`) so each GitHub call uses its own `RepoRef`.

---

## M18 — `findByPeriod` does not do what its docstring says

**File:** `server/src/modules/digests/repository.ts:14-40`

The comment promises *"Periods are matched on their exact boundaries rather than by
overlap"*, but the query is a **containment** query
(`periodStart >= :start AND periodEnd <= :end`) with no ordering and no `limit(1)`.
Any narrower digest nested inside the requested window matches, and which row comes
back is whatever Postgres returns first. Combined with C7's
`await repo.deleteById(workspaceId, existing.id)`, a regenerate request can delete
an unrelated, narrower digest.

**Fix:** `eq(t.digests.periodStart, periodStart)` and `eq(t.digests.periodEnd, periodEnd)`
to match the stated contract, plus `.limit(1)` and a deterministic `orderBy`.

---

## L19 — 40 sequential GitHub + LLM round-trips inside one HTTP request

**File:** `server/src/modules/digests/service.ts:67-78`, `constants.ts:6`

`MAX_PRS_PER_DIGEST = 40` sequential `getPullRequest` + `llm.complete` pairs run
inside the `POST /digests` handler. At a realistic couple of seconds per model call
this is a multi-minute request. The container already exposes `jobs: JobRunner`, and
the repo has a rate-limit note on exactly this kind of endpoint
(`server/INSIGHTS.md` 2026-08-28, "The global rate limit is sized for the internet,
but the caller is one browser tab").

**Suggestion (non-blocking):** run the build as a job and return a handle, or at
minimum bound the concurrency of the per-PR loop.

---

## L20 — `markUsed` is unguarded and runs before dedupe

**File:** `server/src/modules/memory/service.ts:48`, `repository/item.repo.ts:21`

`item.repo.ts` documents the intent — *"a failed touch must never fail the read"* —
but the service `await`s `markUsed` bare, so a failed update does fail the read. It
also touches rows that `dedupeByContent` is about to discard, inflating recency for
duplicates.

**Suggestion (non-blocking):** dedupe first, then `markUsed` the survivors inside a
try/catch (or fire-and-forget with a logged rejection).

---

## L21 — 404 for an empty result set

**File:** `server/src/modules/digests/service.ts:53-55`

`throw new NotFoundError('No pull requests were merged in this period')` maps a
legitimately empty window to a 404. "Nothing merged last week" is a valid answer,
not a missing resource, and the client cannot distinguish it from a bad workspace.

**Suggestion (non-blocking):** return a digest with an empty body, or a 200 with an
explicit empty marker.

---

## Checked and clean

- `server/src/modules/memory/routes.ts` — presentation-only: Zod schemas declared via
  `fastify-type-provider-zod`, `getContext` for the workspace, one service call per
  handler, no repository or adapter touch, no business branching. Matches
  `reviews/routes.ts`.
- `server/src/modules/memory/service.ts` — constructor takes the whole `Container`
  (the documented, accepted trade-off in `guides/pitfalls-and-tradeoffs.md`, not a
  finding), builds its own `MemoryRepository` from `container.db`, resolves the
  embedder through the container port, and degrades gracefully. No `db/schema.js`
  import.
- `server/src/modules/memory/repository.ts` + `repository/{item,search}.repo.ts` —
  the facade-over-aggregate split is the prescribed convention
  (`reviews/repository.ts`); the axis-of-change rationale in the docstring is exactly
  the reasoning `pitfalls-and-tradeoffs.md` endorses. Only the type-import direction
  is wrong (H9).
- `memory/helpers.ts`, `memory/constants.ts`, `digests/constants.ts` — pure, I/O-free,
  no layering concerns.
- `digests/repository.ts` — correctly the only digests file that should touch Drizzle;
  scoped by `workspaceId` on every query. Its problems (M18) are correctness, not
  layering.
- Both `digests` and `memory` target tables that already exist in the schema
  (`db/schema/ops.ts:41` and `db/schema/knowledge.ts:8`), so no migration is needed.
- No `client/` or `mcp/` files are touched by this PR.
