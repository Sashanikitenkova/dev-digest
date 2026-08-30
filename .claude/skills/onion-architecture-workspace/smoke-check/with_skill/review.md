# PR review — `modules/digests`, `modules/memory`, `reviewer-core/src/review/summarize.ts`

Reviewed against `.claude/skills/onion-architecture` (SKILL.md + all five guides),
`server/CLAUDE.md`, `reviewer-core/CLAUDE.md` and `TESTING.md`.

**Verdict: request changes.** Six blocking violations of the Dependency Rule and the
grounding invariant, plus a file that cannot typecheck. `modules/memory` is close to
clean and is a good model for what `modules/digests` should look like.

Paths below are relative to `evals/fixtures/`, i.e. read
`server/src/modules/digests/service.ts` as the proposed `server/src/modules/digests/service.ts`.

---

## Blocking

### 1. `reviewer-core/src/review/summarize.ts:39-41` — the core constructs its own LLM provider and reads an API key

```ts
const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error('OPENROUTER_API_KEY is not configured');
const llm = new OpenRouterProvider(key, { timeoutMs: 60_000 });
```

This is the exact anti-pattern `guides/reviewer-core-llm-port.md` calls out: `OpenRouterProvider`
is allowed to *live* in `reviewer-core`, but it may only be **constructed at a consumer's
composition root**. `reviewer-core/src/index.ts` promises "the only side effect is an LLM call
through an INJECTED LLMProvider"; this file breaks that for both consumers at once. It also
bypasses `SecretsProvider` — `server/CLAUDE.md` states secrets resolve through
`SecretsProvider` (`~/.devdigest/secrets.json`), not `process.env`, and `container.buildLlm()`
already injects a `PriceBook`-backed cost estimator that this construction silently drops
(every summarise call will report `costUsd: null`).

**Fix:** add `llm: LLMProvider` to `SummarizeInput` (mirroring `ReviewInput.llm` in
`review/run.ts`) and delete lines 5, 39-41. Callers pass `await container.llm('openrouter')`.
Take `model` as an input too rather than hardcoding `SUMMARY_MODEL` (line 7).

### 2. `reviewer-core/src/review/summarize.ts:1, 44-46` — filesystem access inside the pure core

```ts
import { readFile } from 'node:fs/promises';
...
for (const path of input.skillPaths ?? []) {
  skills.push(await readFile(path, 'utf8'));
}
```

`reviewer-core` has zero filesystem access by design. `ReviewInput` documents the contract —
"Resolved skill bodies (NOT slugs)" — precisely because the studio resolves skills from the DB
and the CI runner from disk. Accepting `skillPaths` hardcodes the runner's world into the
engine and makes the studio path impossible.

**Fix:** replace `skillPaths?: string[]` with `skills?: string[]` (already-resolved bodies) and
drop the `node:fs/promises` import and the loop. Resolution moves to the caller.

### 3. `reviewer-core/src/review/summarize.ts:55-66` — findings returned without passing the grounding gate

`result.data.findings` goes straight into `SummarizeOutcome` with no `groundFindings()` call.
This is the "bad" example verbatim from `guides/reviewer-core-llm-port.md` §2, and
`reviewer-core/CLAUDE.md` calls grounding non-negotiable: "never bypass `groundFindings()` or
trust the model's self-reported score". These findings are diff-anchored (the diff is fed in at
line 51) so hallucinated line ranges will reach the PR page unfiltered.

Made worse by line 11: `z.array(z.custom<Finding>())` validates nothing at all — `z.custom` with
no validator accepts any value, so the structured-output repair loop cannot reject a malformed
finding either. Use the shared `Finding` Zod schema from `@devdigest/shared` (as `review/run.ts`
does with `ReviewSchema`).

**Fix:** pipe through `groundFindings(findings, input.diff)` before returning, and recompute any
score from the survivors.

### 4. `server/src/modules/digests/service.ts:2, 64` — a service imports and constructs a concrete adapter

```ts
import { OctokitGitHubClient } from '../../adapters/github/octokit.js';
...
const github = new OctokitGitHubClient(process.env.GITHUB_TOKEN ?? '');
```

`platform/container.ts` is the only file allowed to import `adapters/*`
(`guides/fastify-routing-and-di.md`, "Composition-root discipline"). Three concrete consequences:

- It bypasses `ContainerOverrides.github`, so `server/test/digests-service.test.ts` — which
  overrides `llm`, `embedder` and `git` but NOT `github` (lines 30-34) — will make live GitHub
  calls, or silently 401 with an empty token, in CI.
- `?? ''` swallows the missing-credential case that `container.github()` reports as a
  `ConfigError`, turning a config problem into an opaque 401 mid-loop.
- It reads `process.env` instead of `SecretsProvider`, so a token stored via the settings UI in
  `~/.devdigest/secrets.json` is ignored.

**Fix:** `const github = await this.container.github();` and delete the import.

### 5. `server/src/modules/digests/service.ts:1, 5, 32-51, 57-60` — the service queries Drizzle directly

The service imports `db/schema.js` and builds two `this.container.db.select()` queries (merged
PRs; the repo row). `guides/drizzle-repository-pattern.md`: "No `service.ts` or `routes.ts` file
imports `db/schema.js` or builds a `db.select()`/`db.insert()` query directly." A
`DigestsRepository` already exists two lines above (line 28) and is where these belong; it is
also odd that `digests/repository.ts` owns the `digests` table while the service reaches around
it for `pull_requests` and `repos`.

**Fix:** add `listMergedInPeriod(workspaceId, periodStart, periodEnd, limit)` and
`getRepoRef(repoId)` to `DigestsRepository` (or use the shared `container.reviewRepo` for pull
rows, which is what it exists for), and drop the `drizzle-orm` / `db/schema.js` imports from the
service.

### 6. `server/src/modules/digests/service.ts:6, 83-85` — reaching into another module's per-aggregate repository file

```ts
import { nearest } from '../memory/repository/search.repo.js';
...
const related = await nearest(this.container.db, workspaceId, queryVector, { ... });
```

Two violations in one import. First, it crosses a module boundary into another domain's data
layer — the container comment is explicit that shared repositories are constructed in the
composition root "so consuming modules use `container.agentsRepo` instead of reaching into
another module's folder." Second, even within `memory` this reaches *past* the
`MemoryRepository` facade into `repository/search.repo.ts`, which
`guides/drizzle-repository-pattern.md` names as the inverse mistake that "defeats the point of
having a stable composed API" — and it hands a raw `Db` handle across the boundary while doing so.

**Fix:** either call `MemoryService.search()` (the memory domain's own public entry point, which
also applies `dedupeByContent` and `markUsed`), or expose `memoryRepo` on `Container` next to
`agentsRepo`/`reviewRepo` if the digest path genuinely needs raw vector access.

### 7. `server/src/modules/digests/routes.ts:6, 28, 36-46` — the route holds a repository and owns the business rule

```ts
const repo = new DigestsRepository(app.container.db);
...
const existing = await repo.findByPeriod(workspaceId, periodStart, periodEnd);
if (existing && !req.body.regenerate) return { digest: existing, cached: true };
if (existing) await repo.deleteById(workspaceId, existing.id);
const digest = await service.build(...);
```

Routes are presentation-only: validate → call service → shape response
(`guides/fastify-routing-and-di.md`). Here the route constructs a repository directly, computes
the period window (lines 33-34), and owns the entire reuse-vs-rebuild decision — which is the
module's central business rule, documented in the route's own doc comment ("a digest for a
period that was already built is reused unless the caller asks for a rebuild"). As written that
rule can only be tested by booting Fastify, and `GET /digests` (line 52) skips the service
entirely.

**Fix:** move it into `DigestsService.generate(workspaceId, { periodDays, regenerate })`
returning `{ digest, cached }`, and add `DigestsService.list(workspaceId, limit)`. The route
keeps only `getContext` → one service call → response. Drop the `DigestsRepository` import from
`routes.ts`.

### 8. Neither module is registered in `server/src/modules/index.ts`

`modules/index.ts` is a static registry and its doc comment states the contract: "create
`modules/<name>/routes.ts` exporting a default Fastify plugin, then add one import + one entry
below." Neither `digests` nor `memory` appears in the PR, so both plugins are dead code and
`server/test/digests-service.test.ts` would 404 on `POST /digests`.

**Fix:** add `import digests from './digests/routes.js';` / `import memory from
'./memory/routes.js';` and the two registry entries.

### 9. `server/test/digests-service.test.ts` — DB-backed test with the wrong filename

The file imports `test/helpers/pg.js` and starts a real Postgres (lines 2, 25). `TESTING.md` and
`server/CLAUDE.md` are both explicit: "A DB-backed test **must** be named `*.it.test.ts` or the
unit/integration split silently miscategorizes it." Under the current name the unit lane
(`vitest run --exclude '**/*.it.test.ts'`) will try to run it and fail (or Docker-skip
misleadingly), and the integration lane (`vitest run .it.test`) will never select it.

**Fix:** rename to `server/test/digests.it.test.ts`. Also add a `github:
new MockGitHubClient()` override once finding 4 is fixed, otherwise the test still reaches the
network.

### 10. `reviewer-core/src/review/summarize.ts:48-60` — the file does not typecheck against the real APIs

Two signature mismatches; `npm run typecheck` (which is this package's build) will fail:

- `assemblePrompt` takes `PromptParts` — `{ system: string; skills?: string[]; ... diff: string }`
  (`prompt.ts:200`). The call passes `systemPrompt:` (no such field, `system` is required) and a
  `UnifiedDiff` object where a string is expected.
- `completeStructured` takes `StructuredRequest<T>` — `{ model, schema, schemaName, messages, ... }`
  (`vendor/shared/adapters.ts:55`). The call passes `system:`/`user:` and omits the required
  `schemaName`, so `toJsonSchema(req.schema, req.schemaName)` would also receive `undefined`.

Compare `review/run.ts:193-200` for the correct shape.

---

## Non-blocking

### 11. `server/src/modules/digests/repository.ts:29-38` — `findByPeriod` doesn't do what its doc comment says

The comment (lines 17-19) claims "periods are matched on their exact boundaries", but the query
uses `gte(periodStart, periodStart)` + `lte(periodEnd, periodEnd)`, i.e. *any digest contained
within* the window. A weekly digest is therefore returned as the "existing" match for a monthly
request — and then deleted by `routes.ts:43` on regenerate. Use `eq()` on both bounds (and add
`.limit(1)` plus a deterministic `orderBy`, since `[row] =` silently picks an arbitrary row).

### 12. `server/src/modules/memory/service.ts:48` — the awaited `markUsed` contradicts its own contract

`repository/item.repo.ts:21` states "a failed touch must never fail the read", but the service
awaits `markUsed` unguarded, so a write failure rejects the whole search. Wrap in
`try {} catch {}` (or `void`-fire with a logged catch) to match the documented intent. Minor:
`markUsed` is also the only repository method not workspace-scoped — it updates by id alone.

### 13. `server/src/modules/digests/service.ts:57-60` — a single repo row is assumed for the whole period

`repoRow` is looked up from `merged[0]!.repoId` and then used as the GitHub coordinates for
*every* PR in the loop (line 69). A workspace with two repos will fetch PR numbers from the
wrong repository — wrong `detail.body` fed to the model, or a 404. Group by `repoId`, or resolve
the ref per PR.

### 14. `server/src/modules/digests/service.ts:68-78` — sequential N GitHub + N LLM calls, and silent truncation

Up to `MAX_PRS_PER_DIGEST` (40) round-trips of each, strictly serial, inside an HTTP request
handler. Worth batching/bounding concurrency, and worth telling the caller when the window was
truncated at 40 rather than silently dropping the oldest PRs. Also `container.llm('openrouter')`
(line 65) hardcodes a provider where the rest of the codebase resolves it from configuration.

### 15. `server/src/modules/memory/service.ts:57-65` — `embedOrNull` swallows every error

The bare `catch { return null }` is deliberate per the doc comment (offline degradation), but it
also hides programming errors and makes a misconfigured embedder indistinguishable from an
absent one. Log at debug level before returning `null`.

### 16. `reviewer-core/src/review/summarize.ts` is not exported from `reviewer-core/src/index.ts`

If the server or the CI runner is meant to call `summarizeReview`, it needs an entry in
`index.ts` alongside `reviewPullRequest`. If it isn't meant to be public yet, say so — right now
it is an unreachable new file.

---

## Checked and clean

- **`modules/memory` layering.** `routes.ts` is genuinely presentation-only (Zod schema →
  `getContext` → one service call → shape); `service.ts` takes `Container` and never touches
  Drizzle; the facade-over-`repository/{item,search}.repo.ts` split mirrors
  `modules/reviews/repository.ts` exactly, with a doc comment justifying the seam. This is the
  shape `digests` should be refactored into.
- **`helpers.ts` / `constants.ts` in both modules.** Pure, I/O-free, and precedented by
  `modules/settings/` — not "ad hoc extra top-level files". Not a finding.
- **Whole-`Container` injection into both services** and **row types (`DigestRow`, `MemoryRow`)
  doubling as DTOs** are documented, intentional compromises in this repo
  (`guides/pitfalls-and-tradeoffs.md`) — deliberately not flagged.
- **`memory`'s aggregate split for a small domain** is borderline against the "don't
  over-engineer" guidance, but the two files have genuinely different reasons to change (schema
  vs. pgvector tuning) and the doc comment says so. Accepted.
- **Workspace scoping** is present on every memory and digest query except `markUsed` (see 12).
- The `digests` and `memory` tables already exist in `db/schema/{ops,knowledge}.ts` with matching
  columns, so no migration is missing.
