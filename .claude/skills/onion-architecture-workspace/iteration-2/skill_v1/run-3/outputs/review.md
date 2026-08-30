# PR review — `modules/digests`, `modules/memory`, `reviewer-core/src/review/summarize.ts`

Reviewed against DevDigest's onion/hexagonal conventions (routes → service → repository, ports in
`server/src/vendor/shared/adapters.ts`, adapters constructed only in `server/src/platform/container.ts`,
`reviewer-core` pure except an injected `LLMProvider`), plus `TESTING.md` and the existing module corpus.

**Verdict: request changes.** The `memory` module is close to mergeable. `digests/service.ts`,
`digests/routes.ts` and `reviewer-core/src/review/summarize.ts` each break the Dependency Rule in ways
that are load-bearing (untestable without live network, secrets read from the wrong place, ungrounded
findings reaching the UI), and neither module is registered so neither route is actually mounted.

---

## Blocking — Dependency Rule violations

### 1. `reviewer-core/src/review/summarize.ts:5, 39-41` — the core constructs its own LLM provider and reads an API key

```ts
const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error('OPENROUTER_API_KEY is not configured');
const llm = new OpenRouterProvider(key, { timeoutMs: 60_000 });
```

`reviewer-core/src/index.ts`'s own contract is "NO database, GitHub, or filesystem access; the only side
effect is an LLM call through an INJECTED LLMProvider". `OpenRouterProvider` is allowed to *live* in the
package (it is shared by the studio and the CI runner) but is allowed to be *constructed* only at a
consumer's composition root — `container.ts`'s `buildLlm()` does exactly that, resolving the key through
`SecretsProvider`. Constructing it here makes `summarizeReview()` unmockable, bypasses the `PriceBook`
cost attribution that `buildLlm()` injects, and reads a secret from `process.env` when this project keeps
secrets in `~/.devdigest/secrets.json`.

**Fix:** add `llm: LLMProvider` to `SummarizeInput` and use `input.llm`. Delete the `OpenRouterProvider`
import and the `process.env` read. Both composition roots already have a provider to pass in.

### 2. `reviewer-core/src/review/summarize.ts:1, 43-46` — filesystem access inside the pure core

```ts
import { readFile } from 'node:fs/promises';
...
for (const path of input.skillPaths ?? []) {
  skills.push(await readFile(path, 'utf8'));
}
```

`reviewer-core` has zero filesystem access by design; `ReviewInput` in `review/run.ts` documents the
convention for exactly this case ("Resolved skill bodies (NOT slugs)"). Reading files here also lets a
caller-supplied absolute path pull arbitrary file contents into a prompt.

**Fix:** replace `skillPaths?: string[]` (line 20) with `skills?: string[]` and have the caller in
`server/` resolve the bodies to strings before calling. Drop the `node:fs/promises` import.

### 3. `reviewer-core/src/review/summarize.ts:55-66` — findings returned without passing the grounding gate

```ts
const result = await llm.completeStructured({ ... });
return { headline: result.data.headline, findings: result.data.findings, model: SUMMARY_MODEL };
```

Grounding is a mandatory domain invariant, not optional post-processing: a finding is kept only if its
line range intersects a real hunk. `review/run.ts:216` pipes every LLM finding through
`groundFindings(merged.findings, input.diff)`. This new path takes raw model output and hands it straight
to the caller for display "above the fold on the PR page" — precisely the hallucinated-citation case the
gate exists to stop. `CLAUDE.md` states grounding is mandatory across the pipeline.

**Fix:** `const ground = groundFindings(result.data.findings, input.diff);` and return `ground.kept`.
`groundFindings` already takes a `UnifiedDiff`, which is what `SummarizeInput.diff` holds. Recompute any
derived score from the survivors rather than trusting the model's.

### 4. `server/src/modules/digests/service.ts:2, 64` — a service constructs a concrete adapter and reads a secret from the environment

```ts
import { OctokitGitHubClient } from '../../adapters/github/octokit.js';
...
const github = new OctokitGitHubClient(process.env.GITHUB_TOKEN ?? '');
```

Two separate violations. (a) `platform/container.ts` is the only file permitted to import from
`adapters/*`; every other layer uses port-typed container members. (b) GitHub credentials come from
`SecretsProvider` — `container.github()` does `await this.secrets.get('GITHUB_TOKEN')` and raises
`ConfigError` when it is absent. As written this bypasses `ContainerOverrides.github`, so the module can
only be tested against live GitHub, and the `?? ''` fallback silently builds an *unauthenticated* Octokit
that will fail with rate-limit/404 errors instead of a clear config error.

**Fix:** `const github = await this.container.github();` and delete both the adapter import and the
`process.env` read.

### 5. `server/src/modules/digests/service.ts:1, 5, 32-51, 57-60` — Drizzle queries inside a service

The service imports `drizzle-orm` operators and `db/schema.js` and runs `this.container.db.select()`
against `t.pullRequests` and `t.repos`. The repository is the only layer that touches the DB for a
domain (`reviews/repository.ts`: "The ONLY layer touching the DB for the review domain"); no `service.ts`
in this repo imports `db/schema.js`.

**Fix:** move both queries behind `DigestsRepository` (e.g. `listMergedPulls(workspaceId, periodStart,
periodEnd, limit)` and `getRepoRef(repoId)`). Note that `pull_requests` and `repos` are other modules'
aggregates — prefer the shared cross-cutting accessors on `Container` (the pattern used for
`container.reviewRepo` / `container.agentsRepo`) over duplicating those queries in a third module.

### 6. `server/src/modules/digests/service.ts:6, 83-85` — reaching into another module's repository, past its facade

```ts
import { nearest } from '../memory/repository/search.repo.js';
...
const related = await nearest(this.container.db, workspaceId, queryVector, { limit: RELATED_MEMORY_LIMIT });
```

This is two violations at once: `digests` reaches directly into `memory`'s data layer, and it reaches
*past* the `MemoryRepository` facade into an aggregate file. The facade-over-aggregate split exists so
callers get one stable composed API; importing `repository/<aggregate>.repo.ts` from outside defeats it,
and the sibling PR file `memory/repository.ts:47` already exposes `nearest` on the facade.

**Fix:** call `MemoryService.search()` (which also applies `dedupeByContent` and `markUsed`), or if only
raw nearest-neighbour rows are wanted, add a shared `container.memoryRepo` getter and use
`container.memoryRepo.nearest(...)`. Do not import another module's `repository/*.repo.ts`.

### 7. `server/src/modules/digests/routes.ts:6, 28, 33-46, 52` — business logic and direct repository access in the route

```ts
const repo = new DigestsRepository(app.container.db);
...
const periodStart = new Date(periodEnd.getTime() - req.body.periodDays * 24 * 60 * 60 * 1000);
const existing = await repo.findByPeriod(workspaceId, periodStart, periodEnd);
if (existing && !req.body.regenerate) return { digest: existing, cached: true };
if (existing) await repo.deleteById(workspaceId, existing.id);
const digest = await service.build(...);
```

Routes are presentation-only: Zod validation → service call → response shaping. Here the handler owns the
window computation, the cache-hit rule, the regenerate/delete rule, and three direct repository calls.
None of it can be tested without booting Fastify, and a second caller of digest generation (MCP, the
CI runner) would have to reimplement the caching rule.

**Fix:** collapse to one call — `const { digest, cached } = await service.generate(workspaceId,
{ periodDays: req.body.periodDays, regenerate: req.body.regenerate })` — and move the window math,
lookup, delete and build into `DigestsService`. Add `service.list(workspaceId, limit)` for the GET.
Remove the `DigestsRepository` import from `routes.ts`.

---

## High

### 8. Neither module is registered — `server/src/modules/index.ts` (unchanged by this PR)

`modules/index.ts` is a static registry: "ADD A MODULE: create `modules/<name>/routes.ts` exporting a
default Fastify plugin, then add one import + one entry below." The PR adds no entry for `digests` or
`memory`, so neither route tree is mounted and every endpoint 404s. The digests integration test would
fail for this reason alone if it ran (see #9).

**Fix:** add `import digests from './digests/routes.js';` and `import memory from './memory/routes.js';`
plus the two entries in the `modules` object.

### 9. `server/test/digests-service.test.ts:2-3, 25-27` — DB-backed test with the wrong filename, so it never runs

The file calls `startPg()` from `test/helpers/pg.js` and runs against a real Postgres. `TESTING.md`:
"A DB-backed test that imports `test/helpers/pg.ts` must use the `.it.test.ts` suffix." The unit lane runs
`vitest run --exclude '**/*.it.test.ts'` and the integration lane runs `vitest run .it.test` — with the
current name the test is picked up only by the unit lane, where Docker is unavailable, so
`dockerAvailable()` returns false and the whole suite is silently `describe.skip`ped. It is dead code in
CI. (All 15 existing DB-backed suites use the suffix: `reviews.it.test.ts`, `blast.it.test.ts`, …)

**Fix:** rename to `server/test/digests-service.it.test.ts`.

### 10. `server/src/modules/digests/service.ts:80` — `container.embedder()` called without the required try/catch

`Container.embedder()` throws `ConfigError('Embeddings are disabled …')` when `EMBEDDINGS_ENABLED` is
false, and its own doc comment says "All callers wrap this in try/catch and degrade gracefully". The
sibling `MemoryService.embedOrNull` (`memory/service.ts:57-65`) does this correctly. Here the throw
propagates, so with embeddings off — the default for a local install — digest generation fails outright
*after* having already paid for up to 40 model calls.

**Fix:** wrap the `embedder()`/`embed()` pair in try/catch and skip the related-memory section on
failure, mirroring `embedOrNull`.

---

## Medium — correctness

### 11. `server/src/modules/digests/repository.ts:24-40` — the cache lookup can never match

The doc comment (lines 16-19) says "Periods are matched on their exact boundaries", but the predicate is
`gte(digests.periodStart, periodStart)` + `lte(digests.periodEnd, periodEnd)` — a containment test, not
equality. Combined with `routes.ts:33` recomputing `periodEnd = new Date()` on every request, the new
`periodStart` is always *later* than the stored row's, so `gte(stored.periodStart, periodStart)` is always
false. `cached: true` is unreachable and every POST re-bills a full model run over the window. There is
also no `.orderBy()`/`.limit(1)`, so if it ever did match multiple rows the one returned is arbitrary.

**Fix:** quantise the window (e.g. truncate to day boundaries in the service) and match with `eq` on both
columns, plus `.limit(1)`. Add a test that asserts `cached: true` on the second identical request — the
existing test (#9) only ever exercises the first.

### 12. `server/src/modules/digests/service.ts:57-60, 69` — every PR is attributed to the first PR's repository

```ts
const [repoRow] = await ...where(eq(t.repos.id, merged[0]!.repoId));
...
const detail = await github.getPullRequest({ owner: repoRow.owner, name: repoRow.name }, pr.number);
```

A workspace can hold several repos, and the query is workspace-scoped. Any PR from a second repo is
fetched from the wrong `owner/name` — a 404 (which aborts the whole digest, see #15) or, worse, a
silently wrong PR body summarised into the digest.

**Fix:** join `repos` into the merged-PR query, or group by `repoId` and resolve each repo once.

### 13. `server/src/modules/digests/service.ts:43-51` — the window has no upper bound

The filter is `gte(t.pullRequests.updatedAt, periodStart)` only; `periodEnd` is accepted but never used
in the query. A regenerate for a historical window silently includes everything merged since. Separately,
`updatedAt` is being used as a proxy for merged-at, so a merged PR touched later drifts into the wrong
digest.

**Fix:** add `lte(t.pullRequests.updatedAt, periodEnd)`, and prefer a real merged-at timestamp if the
schema has one.

### 14. `server/src/modules/digests/service.ts:68-78` — up to 80 sequential network round-trips in one HTTP request

`MAX_PRS_PER_DIGEST` is 40 and the loop does one GitHub fetch plus one LLM call per PR, serially, with no
concurrency cap, no per-item timeout and no error tolerance — a single failed `getPullRequest` throws away
every model call already paid for. The route awaits all of it inline.

**Fix:** bounded concurrency (the repo's other fan-out paths do this), tolerate per-PR failures by
skipping the PR rather than failing the digest, and consider running the build as a job rather than
inside the request.

### 15. `server/src/modules/digests/service.ts:53-54` — 404 for an empty period

`throw new NotFoundError('No pull requests were merged in this period')` maps a legitimately empty result
onto "resource not found". A quiet week is a valid answer.

**Fix:** return an empty digest (or a 200 with an explicit empty body) and let the client render "nothing
merged".

### 16. `server/src/modules/memory/service.ts:48` — the "must never fail the read" contract is not honoured

`item.repo.ts:21` states "Recency feeds ranking later; a failed touch must never fail the read", but
`await this.repo.markUsed(rows.map((r) => r.id));` is unguarded, so a failed `UPDATE` fails the search —
in a panel the module's own doc comment (lines 22-25) says "must not take the others down with it".

**Fix:** `void this.repo.markUsed(...).catch(() => {})`, or wrap in try/catch.

---

## Low

### 17. `reviewer-core/src/review/summarize.ts:48-60` — the call does not match either API it targets

- `assemblePrompt` takes `PromptParts` with `system: string` and `diff: string`; this passes
  `systemPrompt` and a `UnifiedDiff`.
- It returns `{ messages, assembly }`; this reads `prompt.system` / `prompt.user`.
- `LLMProvider.completeStructured` takes `StructuredRequest` = `{ model, schema, schemaName, messages }`;
  this passes `{ model, system, user, schema }` with no `schemaName` and no `messages`.

The file cannot typecheck as written. Worth confirming `pnpm build`/typecheck was run on the branch.

### 18. `reviewer-core/src/review/summarize.ts:9-12` — the Zod schema validates nothing

`z.array(z.custom<Finding>())` accepts any array element; a malformed finding passes straight through the
"structured output" guard. Use the shared `Finding` schema from `@devdigest/shared`.

### 19. `reviewer-core/src/review/summarize.ts:7` and `server/src/modules/digests/constants.ts:8` — hardcoded model ids

`'anthropic/claude-3.5-haiku'` is pinned in two new places while the rest of the pipeline resolves models
from agent/settings config. At minimum make it an optional field on `SummarizeInput` / a service option
so a workspace can override it.

### 20. `server/src/modules/memory/repository/item.repo.ts:4`, `search.repo.ts:4` — import cycle with the facade

Both aggregate files do `import type { ... } from '../repository.js'` while `repository.ts` imports them
back. It is type-only so it compiles, but it inverts the direction the equivalent `reviews` split uses:
`reviews/repository/review.repo.ts` declares its own row types and the facade re-exports them
(`export type { FindingRow, PullRow }`).

**Fix:** declare `MemoryRow` / `InsertMemory` / `NearestOptions` in the aggregate files (or a small
`types.ts`) and re-export from `repository.ts`.

### 21. `server/src/modules/memory/**` — no tests

The module ships a pgvector search path and a pure helper with zero coverage. `dedupeByContent`
(`helpers.ts:14`) is pure and directly unit-testable in the style of `test/blast-helpers.test.ts` /
`test/risks-helpers.test.ts`; the search/forget flow warrants a `memory.it.test.ts`.

---

## Checked and clean

- `server/src/modules/memory/routes.ts` — presentation-only: Zod schemas, `getContext`, three
  single-service-call handlers, no repository or adapter imports. Matches `reviews/routes.ts`.
- `server/src/modules/memory/service.ts` — constructed from `Container`, depends on ports
  (`container.embedder()`), no `db/schema.js` import, degrades gracefully. Constructor taking the whole
  `Container` is this repo's documented, intentional trade-off, not a finding.
- `server/src/modules/memory/repository.ts` + `repository/{item,search}.repo.ts` — correct
  facade-over-aggregate split with a stable public API, matching `reviews/repository.ts`.
- `server/src/modules/digests/repository.ts` — correctly the only digests DB layer (`DigestRow` as an
  `$inferSelect` DTO is the accepted row-type compromise); the bug in #11 is a query bug, not a layering
  one.
- `helpers.ts` / `constants.ts` in both modules — standard for this repo (24 existing modules use the
  same pair); both helper files are genuinely pure and the layering depth is proportionate to the domain.
- `search.repo.ts:14` — the pgvector distance expression is parameterised through the `sql` template, not
  string-concatenated.
