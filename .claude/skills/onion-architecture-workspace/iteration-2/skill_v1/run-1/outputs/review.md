# PR Review — `digests` + `memory` server modules, `reviewer-core/review/summarize.ts`

Reviewed against DevDigest's onion/hexagonal conventions (`onion-architecture`
skill snapshot), `server/CLAUDE.md`, `reviewer-core/CLAUDE.md`, and the existing
`reviews` / `repo-intel` modules as the canonical examples.

**Verdict: request changes.** The `memory` module is close to mergeable. The
`digests` module and `reviewer-core/src/review/summarize.ts` contain several
Dependency-Rule violations, one of which breaks the repo's single non-negotiable
domain invariant (citation grounding).

Findings are ordered most-important-first.

---

## Blocking

### 1. `summarize.ts` returns model findings without the grounding gate
`reviewer-core/src/review/summarize.ts:62-66` (and `:55-60`)

```ts
return {
  headline: result.data.headline,
  findings: result.data.findings,
  model: SUMMARY_MODEL,
};
```

Raw `StructuredResult.data.findings` is handed straight back to the caller.
`reviewer-core/CLAUDE.md` states: "Grounding is mandatory — never bypass
`groundFindings()` or trust the model's self-reported score". `grounding.ts`
exists precisely to drop findings whose `[start_line, end_line]` does not
intersect a real hunk. This is the one invariant the whole engine is built
around, and `summarize.ts` is a new code path that produces `Finding[]` from a
diff without it — so hallucinated line citations will reach the PR page.

**Fix:** pipe the model's findings through `groundFindings(findings, input.diff)`
before returning, exactly as `review/run.ts` does, and return the grounding
summary alongside so callers can report drops. If the second pass is only meant
to *re-rank findings the first pass already grounded*, then it should accept
those already-grounded findings as input rather than asking the model for new
ones.

### 2. `summarize.ts` constructs its own provider and reads an API key
`reviewer-core/src/review/summarize.ts:5`, `:39-41`

```ts
import { OpenRouterProvider } from '../llm/openrouter.js';
...
const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error('OPENROUTER_API_KEY is not configured');
const llm = new OpenRouterProvider(key, { timeoutMs: 60_000 });
```

`reviewer-core/src/index.ts`'s contract is "the only side effect is an LLM call
through an INJECTED LLMProvider". `OpenRouterProvider` living inside the package
is a documented exception *only because it is constructed exclusively at each
consumer's composition root* — `server/src/platform/container.ts`'s `buildLlm()`
for the studio, the CI runner for the Action. Constructing it inside
`review/summarize.ts` collapses that exception: the engine now picks its own
provider, bypasses `SecretsProvider` (`~/.devdigest/secrets.json` is the source
of truth for keys, not `process.env` — see `server/CLAUDE.md`), bypasses the
injected `estimateCost` price book so this path's cost is never attributed, and
becomes un-mockable, which is why there is no test for it. Note also that
`reviewer-core/src` currently contains **zero** `process.env` references — this
would be the first.

**Fix:** add `llm: LLMProvider` to `SummarizeInput` and drop the import,
the env read, and the `new`. Mirror `ReviewInput.llm`. The model id should
likewise be a parameter (`model: string`) rather than the hardcoded
`SUMMARY_MODEL` at `:7`, since the provider is caller-chosen.

### 3. `summarize.ts` reads the filesystem
`reviewer-core/src/review/summarize.ts:1`, `:20`, `:43-46`

```ts
import { readFile } from 'node:fs/promises';
...
/** Absolute paths of the skill files this agent has enabled. */
skillPaths?: string[];
...
for (const path of input.skillPaths ?? []) skills.push(await readFile(path, 'utf8'));
```

`reviewer-core` has "NO database, GitHub, or filesystem access" by design, and
`ReviewInput` documents the correct shape for this exact input: "Resolved skill
bodies (NOT slugs)". Reading files here also makes the engine's behaviour depend
on the caller's filesystem layout, which the CI runner and the studio server do
not share.

**Fix:** replace `skillPaths?: string[]` with `skills?: string[]` (resolved
bodies) and delete the `node:fs/promises` import. Resolution stays in the
caller — DB in the studio, fs in the runner — as `review/run.ts` already does.

### 4. `DigestsService` imports and constructs a concrete adapter
`server/src/modules/digests/service.ts:2`, `:64`

```ts
import { OctokitGitHubClient } from '../../adapters/github/octokit.js';
...
const github = new OctokitGitHubClient(process.env.GITHUB_TOKEN ?? '');
```

`platform/container.ts` is the only file allowed to import `adapters/*`. This
violation has three concrete consequences beyond the layering rule: (a) it
bypasses `ContainerOverrides.github`, so no test can run this service without
live GitHub network access — and indeed `test/digests-service.test.ts` does not
inject a GitHub mock (see finding 10); (b) it bypasses `SecretsProvider`, which
is where GitHub PATs actually live (`~/.devdigest/secrets.json`), so in a normal
dev install `process.env.GITHUB_TOKEN` is empty and this silently constructs an
unauthenticated Octokit that will 401/rate-limit rather than raising the
`ConfigError('GITHUB_TOKEN is not configured')` the container raises; (c) it
skips the container's client caching.

**Fix:** `const github = await this.container.github();` — typed `GitHubClient`,
no import from `adapters/*`.

### 5. `DigestsService` runs raw Drizzle queries instead of using its repository
`server/src/modules/digests/service.ts:5` (`import * as t from '../../db/schema.js'`),
`:32-51`, `:57-60`

The service builds two `db.select()` queries directly against `t.pullRequests`
and `t.repos`. `reviews/repository.ts` states the invariant: the repository is
"the ONLY layer touching the DB" for its domain, and no `service.ts` imports
`db/schema.js`. `DigestsRepository` already exists next door and this bypasses
it entirely.

**Fix:** move both queries behind methods — e.g.
`digestsRepo.listMergedPullRequests(workspaceId, periodStart, limit)`. Since the
pull-request and repo tables belong to the `pulls`/`repos` domains, the cleaner
option is to read them through the owning module's repository (or a
`container`-level shared repo, as `container.reviewRepo` / `container.agentsRepo`
do for cross-cutting entities) rather than re-implementing the queries here.

### 6. `DigestsService` reaches into another module's per-aggregate repo file
`server/src/modules/digests/service.ts:6`, `:83-85`

```ts
import { nearest } from '../memory/repository/search.repo.js';
...
const related = await nearest(this.container.db, workspaceId, queryVector, { limit: RELATED_MEMORY_LIMIT });
```

Two violations at once. First, it reaches *past* the `MemoryRepository` facade
into `repository/search.repo.js` — the guide calls this out by name as "the
inverse mistake of a caller importing `repository/review.repo.ts`'s functions
directly instead of going through the facade class, which defeats the point of
having a stable composed API". Second, it is a cross-module data-layer import:
`digests` is now coupled to `memory`'s storage internals, so any change to
memory's search (a rerank step, a `markUsed` touch, a scope filter) silently
does not apply here.

**Fix:** call the memory module's public surface —
`new MemoryService(this.container).search(...)`, or a narrower method on it. That
also gets the `dedupeByContent` and `markUsed` behaviour the digest path
currently skips.

### 7. `digests/routes.ts` holds business logic and talks to the repository directly
`server/src/modules/digests/routes.ts:6`, `:28`, `:33-44`, `:52`

```ts
const repo = new DigestsRepository(app.container.db);
...
const existing = await repo.findByPeriod(workspaceId, periodStart, periodEnd);
if (existing && !req.body.regenerate) return { digest: existing, cached: true };
if (existing) await repo.deleteById(workspaceId, existing.id);
const digest = await service.build(...);
```

Routes are presentation-only: validate → call service → shape response. Here the
handler owns the period-window arithmetic (`:33-34`), the cache-hit decision,
the regenerate/delete branch, and a direct repository call in `GET` (`:52`) that
does not go through the service at all. The guide's "bad" example is almost
verbatim this shape. Consequence: the cached/regenerate rule can only be tested
by booting Fastify, and a second caller (the MCP server, a job) reimplementing
"build a digest" will not get the same semantics.

**Fix:** collapse this into one service method —
`service.generate(workspaceId, { periodDays, regenerate })` returning
`{ digest, cached }` — and `service.listRecent(workspaceId, limit)` for the GET.
Drop the `DigestsRepository` import and construction from `routes.ts` entirely.

### 8. Neither module is registered in `modules/index.ts`
`server/src/modules/index.ts` (unchanged by this PR)

New module = `routes.ts` + `service.ts` + `repository.ts`, **registered once in
`modules/index.ts`**. The registry is static on purpose ("we register statically
rather than via filesystem autoload so the same code path works under tsx, the
bundler, and vitest"). As it stands, neither `/digests` nor `/memory` is
reachable, and `test/digests-service.test.ts`'s `app.inject({ url: '/digests' })`
would 404.

**Fix:** add `import digests from './digests/routes.js';` +
`import memory from './memory/routes.js';` and the two matching entries in the
`modules` record.

### 9. DB-backed test is named `*.test.ts`, not `*.it.test.ts`
`server/test/digests-service.test.ts` (whole file; see `:2`, `:15`, `:25-27`)

It calls `startPg()`, seeds a real Postgres, and boots the app. `server/CLAUDE.md`
is explicit: "A DB-backed test **must** be named `*.it.test.ts` or the
unit/integration split silently miscategorizes it." As named, it runs in the
unit lane (`vitest run --exclude '**/*.it.test.ts'`) — where it will attempt
Docker and either skip permanently (`dockerAvailable()` false) or blow the unit
suite's runtime. The skill states the same rule: mocked-ports-only → `*.test.ts`,
real-Postgres → `*.it.test.ts`.

**Fix:** rename to `server/test/digests.it.test.ts`, matching `reviews.it.test.ts`,
`blast.it.test.ts`, etc.

---

## Should fix before merge

### 10. The digests test injects every provider except GitHub
`server/test/digests-service.test.ts:30-34`

```ts
overrides: { llm: {...}, embedder: new MockEmbedder(), git: new MockGitClient() },
```

No `github` override. Combined with finding 4, the service will construct a real
Octokit and make live calls per merged PR. `server/INSIGHTS.md` (2026-08-11)
records this exact failure mode as already having bitten this repo: a partially
injected container "did not fail loudly — it blew the timeout budget", and the
symptom pointed nowhere near the cause. Once finding 4 is fixed the container
path is used, so add `github: new MockGitHubClient()` (or the equivalent from
`src/adapters/mocks.ts`) here. Rule of thumb from that insight: **inject every
provider the code path can reach.**

### 11. Cross-workspace read and single-repo assumption in `build()`
`server/src/modules/digests/service.ts:57-62`

```ts
const [repoRow] = await this.container.db
  .select({ owner: t.repos.owner, name: t.repos.name })
  .from(t.repos)
  .where(eq(t.repos.id, merged[0]!.repoId));
```

Two problems. (a) No `workspaceId` predicate — every other query in this module
is workspace-scoped, and `_shared/context.ts` exists so "workspace scoping is
never forgotten". (b) It takes the repo of the *first* PR and then uses that
`owner/name` for **all** PRs in the loop at `:69`. A workspace with more than one
imported repo will fetch PR `#123` of the wrong repository and either 404 or, worse,
silently summarize an unrelated PR into the digest.

**Fix:** scope the lookup by `workspaceId`, and resolve the repo per PR (batch
the distinct `repoId`s into a map) rather than assuming one repo per digest.

### 12. `findByPeriod` does not do what its doc comment says
`server/src/modules/digests/repository.ts:14-19`, `:29-38`

The comment promises "periods are matched on their exact boundaries", but the
predicate is `gte(periodStart, periodStart)` + `lte(periodEnd, periodEnd)` —
that matches any digest *contained within* the requested window, not an exact
match. Since `periodEnd` is `new Date()` on every request (`routes.ts:33`), a
"same period" re-request never has identical boundaries anyway, so the intended
cache will mostly miss, and when it hits it may return a narrower digest. There
is also no `.orderBy()` or `.limit(1)`, so with several matches the row returned
is whatever Postgres happens to emit first.

**Fix:** decide the semantics and make the code match. If it really is exact
match, use `eq` on both columns and have the route/service normalize
`periodStart`/`periodEnd` to day boundaries so re-requests are comparable. Either
way add `.orderBy(desc(t.digests.periodEnd)).limit(1)`.

### 13. Unguarded `container.embedder()` will fail the whole digest
`server/src/modules/digests/service.ts:80-81`

`Container.embedder()` throws `ConfigError('Embeddings are disabled ...')` when
`EMBEDDINGS_ENABLED` is false, and its doc comment states the contract: "All
callers wrap this in try/catch and degrade gracefully (memory/RAG simply returns
no hits)." Here it is awaited bare, *after* the expensive part of the work
(N GitHub calls + N LLM calls) has already been paid for — so on a default
install the digest build burns the model spend and then throws before persisting
anything. `MemoryService.embedOrNull` (`memory/service.ts:57-65`) gets this
right; copy it.

**Fix:** wrap the embed + related-memory block in try/catch and skip the
"context" lines on failure, matching `repo-intel`'s documented "degrade
gracefully" convention.

### 14. `markUsed` contradicts its own comment
`server/src/modules/memory/service.ts:48`, `server/src/modules/memory/repository/item.repo.ts:21`

`item.repo.ts:21` says "Recency feeds ranking later; **a failed touch must never
fail the read**", but `service.ts:48` does `await this.repo.markUsed(...)` with
no guard, so a failed `UPDATE` (lock contention, read-only replica) rejects the
whole search — the exact outcome the comment rules out, and the opposite of the
module doc's "search degrades to returning nothing rather than throwing".

**Fix:** `await this.repo.markUsed(ids).catch(() => {})`, or fire-and-forget
with a logged rejection.

### 15. Digest building runs synchronously inside the HTTP request
`server/src/modules/digests/routes.ts:30-48` → `service.ts:67-78`

The loop makes up to `MAX_PRS_PER_DIGEST` (40) sequential GitHub calls **and** 40
sequential LLM calls inside a POST handler. That is minutes of wall-clock under a
Fastify request timeout, with no cancellation, no progress, and no partial
persistence — and the module doc itself says "building one costs a model call
over every merged PR in the window". This repo already has the right tool:
`container.jobs` (`JobRunner`), used by `repos/service.ts` and
`repo-intel/routes.ts` for exactly this shape (enqueue → return job id → poll).

**Fix:** enqueue a `DIGEST_JOB_KIND` job and return the job handle, as
`repo-intel/routes.ts:53` does; at minimum, batch the LLM calls concurrently with
a bounded pool instead of `for … await`.

---

## Minor / nits

### 16. `SummaryPayload` does not actually validate findings
`reviewer-core/src/review/summarize.ts:9-12`

`z.array(z.custom<Finding>())` is a type assertion, not a runtime check — it
accepts any JSON value. Since this schema is what drives structured output and
the parse-with-repair loop, a malformed model response passes straight through.
Use the real `Finding` schema from `@devdigest/shared` (as `review/run.ts` does
with `Review as ReviewSchema`).

### 17. `summarize.ts` is not exported from the package entry point
`reviewer-core/src/index.ts` (unchanged by this PR)

Every public engine capability is re-exported from `index.ts` with a comment
block. Consumers import `@devdigest/reviewer-core`, so as submitted
`summarizeReview` is unreachable without a deep path import. Add it to
`index.ts` next to `reviewPullRequest`.

### 18. Dedupe runs after the DB limit
`server/src/modules/memory/service.ts:43-49`

`nearest()` applies `limit` in SQL and `dedupeByContent` then removes rows, so a
caller asking for 8 items can get 3 back. Given the helper's own rationale ("the
same decision gets remembered from several PRs"), this is the common case, not
the edge case. Over-fetch (e.g. `limit * 2`) then dedupe then slice to `limit`.

### 19. Type cycle between the memory repository facade and its aggregate files
`server/src/modules/memory/repository/item.repo.ts:4`, `search.repo.ts:4`

Both import `InsertMemory` / `MemoryRow` / `NearestOptions` from `../repository.js`,
which in turn imports both files — a cycle. It is type-only so it erases at
runtime, but `reviews/repository/review.repo.ts` avoids it by taking row types
from `db/rows.js` and defining its own local row alias. Worth matching that
shape, and consider adding `MemoryRow` to `db/rows.ts` if anything cross-cutting
will consume it.

---

## Checked and clean

- **`memory` module layering** — `routes.ts` is genuinely presentation-only
  (validate → one service call → shape); `service.ts` takes `Container` and holds
  the orchestration; the facade-over-`repository/{item,search}.repo.ts` split
  matches `reviews/repository.ts` and is appropriate for a domain with two real
  reasons to change. This is the right template; `digests` should follow it.
- **`helpers.ts` / `constants.ts` split** in both modules — pure, I/O-free, and
  proportionate; consistent with `settings/helpers.ts`. Not over-layered.
- **Whole-`Container` injection into both services** — an intentional, documented
  compromise in this codebase; not flagged.
- **Row types as DTOs** (`DigestRow`, `MemoryRow` from `$inferSelect`) — likewise
  a documented, accepted trade-off; not flagged.
- **`OpenRouterProvider` physically living inside `reviewer-core`** — the
  documented exception; the problem in finding 2 is the *construction site*, not
  the file's location.
- **Zod validation via `fastify-type-provider-zod` schemas** in both `routes.ts`
  files — correct; no hand-rolled `Schema.parse(req.body)`.
- **Workspace scoping** in `memory`'s repository and in `DigestsRepository` —
  present and correct (the one gap is `service.ts:57-60`, finding 11).
