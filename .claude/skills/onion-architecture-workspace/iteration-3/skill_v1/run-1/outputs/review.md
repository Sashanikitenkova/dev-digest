# PR review — `digests` + `memory` modules, `reviewer-core/review/summarize.ts`

Reviewed against the onion-architecture skill (snapshot v1) and the existing conventions in
`server/src/platform/container.ts`, `server/src/vendor/shared/adapters.ts`, `server/src/db/rows.ts`,
`server/src/modules/index.ts` and `TESTING.md`.

**Verdict: do not merge.** Five Critical layering violations, four High blockers (two of which mean
the modules are dead code and the new test never runs), plus five real correctness bugs.

The `memory` module is close to right — most of the damage is in `digests` and in the new
`reviewer-core` file, which breaks the package's central purity guarantee three separate ways.

---

## Critical

### 1. `reviewer-core/src/review/summarize.ts:39-41` — constructs its own LLM provider and reads an API key

```ts
const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error('OPENROUTER_API_KEY is not configured');
const llm = new OpenRouterProvider(key, { timeoutMs: 60_000 });
```

`reviewer-core/src/index.ts` states the contract: "the only side effect is an LLM call through an
INJECTED LLMProvider". `OpenRouterProvider` is allowed to *live* in the package (it is shared by the
studio server and the CI runner) but it may only be **constructed at a consumer's composition root** —
today that is `server/src/platform/container.ts`'s `buildLlm()`. `grep -rn "process.env" reviewer-core/src`
returns nothing today; this file would be the first.

Two concrete harms: the function is untestable without a live key, and it bypasses the repo's secret
convention entirely (secrets live in `~/.devdigest/secrets.json` via `SecretsProvider`, never in env).

**Fix:** add `llm: LLMProvider` to `SummarizeInput` and delete lines 5 and 39-41. Both composition
roots already resolve a provider; pass it in.

### 2. `reviewer-core/src/review/summarize.ts:1, 43-46` — filesystem access inside the pure core

```ts
import { readFile } from 'node:fs/promises';
...
for (const path of input.skillPaths ?? []) skills.push(await readFile(path, 'utf8'));
```

`reviewer-core` has zero filesystem access by design (`grep -rn "node:fs" reviewer-core/src` is
currently empty). `ReviewInput` already models the correct shape — its doc comment says "Resolved
skill bodies (NOT slugs)".

**Fix:** replace `skillPaths?: string[]` with `skills?: string[]` and resolve the files in the caller
(`server`), where skill bodies are already loaded from the DB.

### 3. `reviewer-core/src/review/summarize.ts:62-66` — findings returned without the grounding gate

```ts
return { headline: result.data.headline, findings: result.data.findings, model: SUMMARY_MODEL };
```

Grounding is a mandatory domain invariant across the whole pipeline, not optional post-processing:
a finding is kept only if its `[start_line, end_line]` intersects a real hunk of the diff for that
file. This new path publishes raw model output — including hallucinated line citations — straight to
the PR page, which is exactly what the gate exists to prevent.

**Fix:** `import { groundFindings } from '../grounding.js'` and pipe `result.data.findings` through it
against `input.diff` before returning; recompute any derived score from the survivors.

### 4. `server/src/modules/digests/service.ts:2, 64` — concrete adapter constructed outside the composition root

```ts
import { OctokitGitHubClient } from '../../adapters/github/octokit.js';
...
const github = new OctokitGitHubClient(process.env.GITHUB_TOKEN ?? '');
```

Only `platform/container.ts` may import from `adapters/*`. This is also the textbook "bad" example in
the skill's routing/DI guide, and it bypasses `SecretsProvider` (`container.github()` does
`await this.secrets.get('GITHUB_TOKEN')`).

The harm is demonstrated by this PR's own test: `server/test/digests-service.test.ts:30-34` overrides
`llm`, `embedder` and `git`, but there is no way to override GitHub — so the test either hits live
GitHub or 401s against an empty token string. That is exactly the testability failure
`ContainerOverrides` exists to prevent.

**Fix:** `const github = await this.container.github();` — nothing else changes, the port has the same
`getPullRequest(repo, n)` signature.

### 5. `server/src/modules/digests/service.ts:1, 5, 32-62` — the service queries Drizzle directly

```ts
import * as t from '../../db/schema.js';
...
const merged = await this.container.db.select({ ... }).from(t.pullRequests).where(...)
const [repoRow] = await this.container.db.select({ ... }).from(t.repos).where(...)
```

`reviews/repository.ts` states the invariant: the repository is "the ONLY layer touching the DB" for
its domain. No `service.ts` imports `db/schema.js`. Worse, both of these queries read tables the
`digests` module doesn't own (`pull_requests`, `repos`), so query logic for another domain is now
duplicated in a third place.

**Fix:** add `listMergedInPeriod(workspaceId, periodStart, periodEnd, limit)` to
`DigestsRepository`, and get the repo row via the pulls module's repository or a container-level
accessor (the `container.agentsRepo` / `container.reviewRepo` pattern exists for precisely this
cross-cutting case — its own comment says "instead of reaching into another module's folder").

---

## High

### 6. `server/src/modules/digests/service.ts:6, 83` — reaches into another module's data layer, past its facade

```ts
import { nearest } from '../memory/repository/search.repo.js';
...
const related = await nearest(this.container.db, workspaceId, queryVector, { limit: RELATED_MEMORY_LIMIT });
```

Two violations in one import. (a) `digests` reaches directly into `memory`'s persistence layer — it
should go through `MemoryService`. (b) It skips the `MemoryRepository` facade and calls the
per-aggregate file's function, which is the named anti-pattern in the repository guide ("a caller
importing `repository/review.repo.ts`'s functions directly instead of going through the facade class,
which defeats the point of having a stable composed API"). Any future change to `nearest`'s signature
now silently breaks `digests`.

**Fix:** `new MemoryService(this.container).search(workspaceId, text, { limit })`, or have the caller
resolve related items and pass them in as data.

### 7. `server/src/modules/digests/routes.ts:6, 28, 36, 43, 52` — the route owns a repository

```ts
const repo = new DigestsRepository(app.container.db);
...
const existing = await repo.findByPeriod(workspaceId, periodStart, periodEnd);
await repo.deleteById(workspaceId, existing.id);
return { digests: await repo.listRecent(workspaceId, req.query.limit) };
```

Routes are presentation-only: parse → call service → shape response. No direct repository access.
Note that `memory/routes.ts` gets this right — the two new modules disagree with each other.

**Fix:** delete the `repo` construction and add `DigestsService.listRecent()`; the route keeps only
`service.*` calls.

### 8. `server/src/modules/digests/routes.ts:33-47` — business logic in the handler

Window arithmetic, the cache-hit decision, and the delete-then-rebuild flow all live in the route:

```ts
const periodStart = new Date(periodEnd.getTime() - req.body.periodDays * 24 * 60 * 60 * 1000);
if (existing && !req.body.regenerate) return { digest: existing, cached: true };
if (existing) await repo.deleteById(workspaceId, existing.id);
```

This is domain policy ("a digest for a period that was already built is reused"), it can only be
tested by booting Fastify, and it is the exact "inline `if` branching plus direct repo calls" case the
DI guide calls out.

**Fix:** one call — `service.generate(workspaceId, { periodDays, regenerate })` returning
`{ digest, cached }`. Move the period computation and the reuse policy into `DigestsService`.

### 9. `server/src/modules/index.ts` — neither module is registered (no fixture change)

`modules/index.ts` is a static registry; a module reaches the app only via one import + one entry
there ("ADD A MODULE: create `modules/<name>/routes.ts` … then add one import + one entry below").
This PR adds no such change, so `digests` and `memory` ship as dead code — none of the routes are
mounted, and `routes-smoke.test.ts` will not see them.

**Fix:** add `import digests from './digests/routes.js';` / `import memory from './memory/routes.js';`
and the two registry entries.

### 10. `server/test/digests-service.test.ts:2, 15, 24-36` — DB-backed test with the wrong filename

The file imports `./helpers/pg.js`, calls `dockerAvailable()` and `startPg()`, and seeds a real
Postgres — but is named `digests-service.test.ts`. `TESTING.md` is explicit: "A DB-backed test that
imports `test/helpers/pg.ts` must use the `.it.test.ts` suffix." As named, it lands in the unit lane
(`vitest run --exclude '**/*.it.test.ts'`), where it will silently `describe.skip` when Docker is
absent, and it is excluded from the integration lane (`vitest run .it.test`) — so it never actually
runs anywhere it is meant to. Every other DB test in `server/test/` follows the suffix.

**Fix:** rename to `server/test/digests-service.it.test.ts`.

---

## Medium — correctness

### 11. `server/src/modules/digests/repository.ts:24-40` — the cache lookup does not do what its doc says, and never hits

The doc comment claims exact-boundary matching, but the query is a containment test:

```ts
gte(t.digests.periodStart, periodStart),
lte(t.digests.periodEnd, periodEnd),
```

Combined with `routes.ts:33` computing `periodEnd = new Date()` fresh on every request, this fails in
both directions:

- **Never reuses an equal window.** A 7-day digest built yesterday has `periodStart` earlier than
  today's `periodStart`, so `gte` is false. The "same period is never billed twice" promise in
  `service.ts:16-23` does not hold — every POST pays for up to 40 model calls.
- **Falsely reuses a narrower one.** `POST {periodDays: 90}` matches a stored 7-day digest (it is
  contained in the 90-day window) and returns it with `cached: true`. There is also no `.limit(1)`
  or `orderBy`, so which one comes back is arbitrary.

**Fix:** normalise the period to a canonical boundary (truncate to the day, or store `periodDays`)
and match with `eq` on both columns; add `.limit(1)` and a unique index on
`(workspace_id, period_start, period_end)`.

### 12. `server/src/modules/digests/service.ts:57-69` — one repo's coordinates used for every PR

`repoRow` is resolved once from `merged[0]!.repoId` and then passed to every
`github.getPullRequest({ owner, name }, pr.number)`. A workspace with more than one repo — the normal
case — looks up PR numbers against the wrong repository, producing either a 404 or, worse, a summary
of an unrelated PR that happens to share a number.

**Fix:** select `owner`/`name` as part of the merged-PRs query (join `repos`), or group the PRs by
`repoId` and resolve the ref per group.

### 13. `server/src/modules/digests/service.ts:53-54` — 404 for a quiet week

```ts
if (merged.length === 0) throw new NotFoundError('No pull requests were merged in this period');
```

An empty window is a valid, successful outcome, not a missing resource. The client cannot distinguish
"nothing merged" from "bad workspace".

**Fix:** return a digest with an empty body (or `200 { digest: null }`) and let the UI render the
empty state.

### 14. `server/src/modules/memory/repository/item.repo.ts:21` vs `service.ts:48` — the stated invariant isn't implemented

The repo file says "Recency feeds ranking later; a failed touch must never fail the read", but the
caller awaits it unguarded:

```ts
await this.repo.markUsed(rows.map((r) => r.id));
return dedupeByContent(rows);
```

A failed `UPDATE` (lock timeout, connection blip) throws out of `search()` and 500s the panel — the
opposite of the documented behaviour, and of the module's own "must not take the others down with it"
promise at `service.ts:19-26`.

**Fix:** `await this.repo.markUsed(...).catch((e) => this.container.log?.warn(e))`, or drop the await.

### 15. `server/src/modules/digests/service.ts:68-78` — sequential N+1 inside an HTTP handler

The loop makes one GitHub round-trip **and** one LLM call per PR, serially, up to
`MAX_PRS_PER_DIGEST = 40` (`constants.ts:6`). At ~2s per model call that is well over a minute of
request time; any proxy timeout leaves a partially-billed request with nothing stored.

**Fix:** parallelise with a small concurrency cap, and/or run generation as a background job (the
`jobs` table already exists in `db/schema/ops.ts`) with the POST returning 202.

---

## Medium — layering / typing

### 16. `server/src/modules/digests/helpers.ts:1, 13` — cross-module type import from another module's repository

```ts
import type { MemoryRow } from '../memory/repository.js';
export function renderMemoryLine(item: MemoryRow): string { return `- _context:_ ${item.content}`; }
```

`server/src/db/rows.ts` exists specifically so cross-cutting consumers "can reference a row shape
WITHOUT importing another module's data layer". This function only reads `.content` anyway.

**Fix:** use a local structural type — `interface HasContent { content: string }`, exactly what
`memory/helpers.ts:5-7` already does — or add `MemoryRow` to `db/rows.ts`.

### 17. `server/src/modules/digests/repository.ts:5` and `server/src/modules/memory/repository.ts:16` — row types declared locally

Both do `export type XRow = typeof t.x.$inferSelect;` in the module. `db/rows.ts`'s convention is
"Each owning repository re-exports its row from here to keep its public type API unchanged."

**Fix:** add `DigestRow` and `MemoryRow` to `db/rows.ts` and re-export from the repositories.

### 18. `reviewer-core/src/review/summarize.ts:48-60` — this file does not type-check against the APIs it calls

Three mismatches against the current signatures in `reviewer-core/src/prompt.ts` and
`vendor/shared/adapters.ts`:

- `assemblePrompt({ systemPrompt, diff: input.diff, ... })` — `PromptParts` requires `system: string`
  (not `systemPrompt`) and `diff: string` (not `UnifiedDiff`).
- `prompt.system` / `prompt.user` — `AssembledPrompt` is `{ messages: ChatMessage[]; assembly: PromptAssembly }`;
  there are no `system`/`user` fields.
- `completeStructured({ model, system, user, schema })` — `StructuredRequest<T>` requires
  `messages: ChatMessage[]` and `schemaName: string`; `system`/`user` are not members.

Suggests the file was never compiled. Whatever else changes, it needs a `pnpm build`/type-check pass
before review.

### 19. `reviewer-core/src/review/summarize.ts:9-12` — the payload schema validates nothing

```ts
findings: z.array(z.custom<Finding>()),
```

`z.custom` with no validator accepts any value, so the parse-with-repair loop in `OpenRouterProvider`
cannot detect a malformed finding — it becomes a cast, not a parse, and the bad shape surfaces later
as a runtime error or a broken UI row.

**Fix:** use the real `Finding` Zod schema from `@devdigest/shared`.

### 20. `server/src/modules/memory/service.ts:57-64` — bare `catch {}` hides every embedder failure

```ts
} catch {
  return null;
}
```

A bad key, a network error, a rate limit and a dimension mismatch all become "no embedding". Writes
silently persist unsearchable rows and searches silently return `[]`, with nothing in the logs to
explain it. Degrading gracefully is the right call (`repo-intel` does the same) — doing it silently
is not.

**Fix:** log at `warn` with the error before returning `null`.

### 21. `server/src/modules/memory/service.ts:43-49` — recency bumped on rows that are about to be dropped

`markUsed` runs over the raw `rows`, then `dedupeByContent` discards the duplicates. Near-duplicates
therefore keep getting their `lastUsedAt` refreshed by searches that never surfaced them, which will
skew the ranking the field is being collected for.

**Fix:** dedupe first, then `markUsed` on the survivors.

---

## Low

### 22. `server/src/modules/memory/repository.ts` + `repository/{item,search}.repo.ts` — facade split ahead of the need

The facade-over-aggregate pattern is for a domain covering multiple aggregates (`reviews` splits over
`review`/`run`/`pull`). Here it is one table and four methods, split into three files plus two
type-only back-imports (`item.repo.ts:4`, `search.repo.ts:4` import from the parent, which is a small
circular-ish coupling). The skill's guidance is to match layering depth to actual complexity — "don't
scaffold a facade-over-aggregates repository for a module that will only ever need two queries".

Not blocking, and the split is defensible if pgvector tuning is expected to grow. Worth noting that
the extra public surface already invited finding #6's bypass.

### 23. `server/test/digests-service.test.ts:9-13` — the test doesn't test what its own comment claims

The doc comment promises "a second request for the same window reuses the stored row rather than
rebuilding", but the test issues one POST. Given finding #11, that assertion would currently fail —
which is a good argument for adding it.

**Fix:** add a second `app.inject` asserting `cached === true` and still `toHaveLength(1)`.

### 24. Missing unit coverage for the pure helpers

`renderDigestMarkdown`, `renderMemoryLine` and `dedupeByContent` are pure and explicitly documented as
"unit-testable on its own", but there is no `digests-helpers.test.ts` / `memory-helpers.test.ts` —
the repo has that convention for `blast`, `brief`, `context`, `intent`, `reviews`, `risks`, `skills`
and `smart-diff`. The `memory` module ships with no tests at all, including none for the
embedder-unavailable degradation path its doc comment is built around.

### 25. `server/src/modules/digests/routes.ts:30-53` — response conventions

POST returns `200` on creation while `memory/routes.ts:39` sets `201` for the analogous case, and
neither module declares `response` schemas in its route options (so nothing is serialization-validated).

### 26. Hardcoded model ids

`reviewer-core/src/review/summarize.ts:7` and `server/src/modules/digests/constants.ts:8` both pin
`anthropic/claude-3.5-haiku`. Model choice elsewhere is per-agent configuration, not a source
constant. At minimum make it an override-able input.

---

## Checked and clean

- `memory/routes.ts` — presentation-only throughout: Zod schemas, `getContext`, three single service
  calls, no repository or adapter access. This is the pattern `digests/routes.ts` should copy.
- `MemoryService` — depends only on `Container` port members (`container.db`, `container.embedder()`);
  constructs no concrete adapters. (Whole-`Container` injection is a documented, accepted trade-off in
  this repo, not flagged.)
- `memory/repository/*.ts` — all Drizzle for the memory domain stays in the data layer.
- `search.repo.ts:14` — `sql\`... <=> ${JSON.stringify(embedding)}::vector\`` binds the embedding as a
  Drizzle parameter rather than interpolating it, so this is not a SQL-injection path.
- Every query in both modules is scoped by `workspaceId`; `deleteItem`/`deleteById` both include the
  tenancy predicate.
- `helpers.ts` in both modules is genuinely pure, and tunables are correctly extracted to `constants.ts`.
- Row types doubling as DTOs, and services taking the whole `Container`, are documented intentional
  compromises in this codebase and are **not** reported as defects above.
