# PR review — `digests` + `memory` server modules, `reviewer-core/review/summarize.ts`

Reviewed against DevDigest's onion/hexagonal conventions (routes → service → repository, ports in
`vendor/shared/adapters.ts`, adapters constructed only in `platform/container.ts`, `reviewer-core`
pure behind an injected `LLMProvider`), plus `server/CLAUDE.md`, `TESTING.md` and `server/INSIGHTS.md`.

**Verdict: do not merge.** The `memory` module is close to exemplary. The `digests` module and
`reviewer-core/src/review/summarize.ts` both break the Dependency Rule in ways that are load-bearing,
and `summarize.ts` additionally does not compile against the real `assemblePrompt` /
`completeStructured` signatures. Neither new module is registered, so neither is reachable at all.

Findings are ordered most-important first.

---

## Blocking

### 1. `reviewer-core/src/review/summarize.ts:39-41` — the core constructs its own LLM provider and reads an API key

```ts
const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error('OPENROUTER_API_KEY is not configured');
const llm = new OpenRouterProvider(key, { timeoutMs: 60_000 });
```

This is the exact violation `reviewer-core/src/index.ts` guards against: *"NO database, GitHub, or
filesystem access; the only side effect is an LLM call through an INJECTED LLMProvider."*
`OpenRouterProvider` is allowed to *live* in the package (it is shared by the studio and the CI
runner), but it may only be **constructed at a composition root** — `container.ts`'s `buildLlm()`,
or the runner. Constructing it here also bypasses the studio's `SecretsProvider`
(`~/.devdigest/secrets.json`) and the injected `estimateCost` price book, so digest-summary spend
silently drops off cost attribution, and no test can mock this path.

**Fix:** add `llm: LLMProvider` to `SummarizeInput`, delete the `OpenRouterProvider` import and the
`process.env` read, and call `input.llm.completeStructured(...)`. Let each consumer pass the
provider it already resolved.

### 2. `reviewer-core/src/review/summarize.ts:1,19,43-46` — filesystem access inside the pure core

```ts
import { readFile } from 'node:fs/promises';
...
for (const path of input.skillPaths ?? []) skills.push(await readFile(path, 'utf8'));
```

`reviewer-core` has zero filesystem access by design — it is the one package in the repo with no
`node:fs` import anywhere today, and this PR introduces the first one. `ReviewInput` shows the
established shape: *"Resolved skill bodies (NOT slugs)"*. Reading absolute paths here also makes the
engine's behaviour depend on the CI runner's and the studio's differing on-disk layouts, and hands
an arbitrary-file-read primitive to whatever populates `skillPaths`.

**Fix:** replace `skillPaths?: string[]` with `skills?: string[]` (already-resolved bodies) and
resolve them in the caller — the DB in `server`, the filesystem in the runner.

### 3. `reviewer-core/src/review/summarize.ts:55-66` — findings returned without the grounding gate

```ts
const result = await llm.completeStructured({ ... });
return { headline: result.data.headline, findings: result.data.findings, model: SUMMARY_MODEL };
```

Raw model findings go straight out. `groundFindings()` is a domain invariant, not optional
post-processing — `reviewer-core/CLAUDE.md`: *"Grounding is mandatory — never bypass
`groundFindings()`."* Every one of these findings carries a `file` + line range that will be
rendered against the diff on the PR page, so hallucinated citations land in the UI. This is
precisely the "bad" case in `guides/reviewer-core-llm-port.md` (a *new* flow reading
`StructuredResult.data.findings` directly).

**Fix:**
```ts
const { kept } = groundFindings(result.data.findings, input.diff);
return { headline: result.data.headline, findings: kept, model };
```

### 4. `server/src/modules/digests/service.ts:2,64` — concrete adapter constructed in a service, secret read from `process.env`

```ts
import { OctokitGitHubClient } from '../../adapters/github/octokit.js';
...
const github = new OctokitGitHubClient(process.env.GITHUB_TOKEN ?? '');
```

Three problems in one line:

- Only `platform/container.ts` may import from `adapters/*`. A `service.ts` importing
  `OctokitGitHubClient` is a straight Dependency Rule violation.
- Secrets resolve through `SecretsProvider` (`~/.devdigest/secrets.json`), never `process.env` —
  a non-default convention called out in `server/CLAUDE.md`.
- `?? ''` degrades silently to an *unauthenticated* Octokit client. Instead of
  `ConfigError('GITHUB_TOKEN is not configured')` the user gets opaque 404s and a 60-req/hr rate
  limit.

The concrete harm is visible in this same PR: `ContainerOverrides.github` is bypassed, so
`server/test/digests-service.test.ts` — which does not inject `github` anyway — will make live,
billed GitHub calls from the test suite. That is verbatim the failure recorded in
`server/INSIGHTS.md` (2026-08-11, *"An integration test that injects only SOME providers silently
hits the real network"*).

**Fix:** `const github = await this.container.github();` and add `github: new MockGitHubClient()`
to the test's overrides.

### 5. `server/src/modules/index.ts` — neither module is registered

The PR adds `modules/digests/routes.ts` and `modules/memory/routes.ts` but no entry in the static
registry. Both plugins are dead code as shipped, and the integration test's `POST /digests` would
404. `modules/index.ts` documents the contract: *"ADD A MODULE: create `modules/<name>/routes.ts`
exporting a default Fastify plugin, then add one import + one entry below."*

**Fix:** add `import digests from './digests/routes.js';` / `import memory from './memory/routes.js';`
and the two matching keys in the `modules` record.

### 6. `reviewer-core/src/review/summarize.ts:48-60` — does not compile against the real APIs

Two independent signature mismatches:

- `assemblePrompt` takes `PromptParts` whose field is `system` (not `systemPrompt`) and whose
  `diff` is a **`string`**, not a `UnifiedDiff` (`reviewer-core/src/prompt.ts:200-244`). It returns
  `{ messages, assembly }` (`prompt.ts:247-250`) — there is no `prompt.system` / `prompt.user`.
- `completeStructured` takes `{ model, schema, schemaName, messages, ... }`
  (`server/src/vendor/shared/adapters.ts:55-70`). The call passes `system`/`user` and omits the
  required `schemaName`, which `toJsonSchema(req.schema, req.schemaName)` needs to name the tool.

**Fix:** build `PromptParts` correctly and pass `messages: prompt.messages` plus a `schemaName`
(e.g. `'ReviewSummary'`).

Related: `summarize.ts` is not re-exported from `reviewer-core/src/index.ts`. That barrel is the
package's public surface (`server` imports `@devdigest/reviewer-core`), so nothing can call this
function until it is exported there.

---

## High

### 7. `server/src/modules/digests/routes.ts:6,28,36-46` — the route owns the business decision and talks to the repository

```ts
const repo = new DigestsRepository(app.container.db);
...
const existing = await repo.findByPeriod(workspaceId, periodStart, periodEnd);
if (existing && !req.body.regenerate) return { digest: existing, cached: true };
if (existing) await repo.deleteById(workspaceId, existing.id);
const digest = await service.build(...);
```

Routes are presentation-only: validate → call the service → shape the response. Here the route
constructs a repository, computes the period window, and implements the entire
reuse-vs-rebuild policy — the module's headline behaviour ("a digest for a period that was already
built is reused unless the caller asks for a rebuild", per its own doc comment). None of it is
testable without booting Fastify, and the delete-then-build sequence is unguarded: if `build()`
throws (it throws routinely — see #9, #16), the previously cached digest is already gone.

**Fix:** move it all behind one call, e.g.
`service.generate(workspaceId, { periodDays, regenerate }): Promise<{ digest, cached }>`, and drop
the `DigestsRepository` import from `routes.ts` entirely. Do the delete after the rebuild succeeds,
or in the same transaction.

### 8. `server/src/modules/digests/service.ts:1,5,32-62` — raw Drizzle in a service, while its own repository sits unused

```ts
import * as t from '../../db/schema.js';
...
const merged = await this.container.db.select({...}).from(t.pullRequests).where(...)
const [repoRow] = await this.container.db.select({...}).from(t.repos).where(...)
```

`DigestsRepository` exists and is used only for the final `insert`. Two full queries — one of them
against another module's table (`repos`) — are built inline in the service. This is the "bad" case
in `guides/drizzle-repository-pattern.md` and breaks the invariant stated in
`reviews/repository.ts`: the repository is the ONLY layer touching the DB for its domain.

**Fix:** add `listMergedPulls(workspaceId, periodStart, periodEnd, limit)` and a repo-lookup method
to `DigestsRepository` (or reuse the pulls/repos modules' repositories via the container), and
remove the `db/schema.js` import from `service.ts`.

### 9. `server/src/modules/digests/service.ts:6,83-85` — reaching past another module's repository facade into its aggregate file

```ts
import { nearest } from '../memory/repository/search.repo.js';
...
const related = await nearest(this.container.db, workspaceId, queryVector, { ... });
```

`memory/repository.ts` exists specifically to compose `item.repo.ts` + `search.repo.ts` behind a
stable API — the guide names importing `repository/<aggregate>.repo.ts` directly as the inverse
mistake that "defeats the point of having a stable composed API." It is worse across a module
boundary: `digests` now depends on `memory`'s internal file layout and passes it a raw `Db` handle.
Any change to how pgvector search is tuned silently breaks digests.

**Fix:** go through `MemoryService.search()` (which also applies `dedupeByContent` and `markUsed`),
or at minimum `new MemoryRepository(container.db).nearest(...)`. Note that going through
`MemoryService` also removes the need for the embed call at line 80-81.

### 10. `server/src/modules/digests/service.ts:80-82` — `container.embedder()` unguarded

`Container.embedder()` throws `ConfigError` when `EMBEDDINGS_ENABLED` is false, and its own comment
states the contract: *"All callers wrap this in try/catch and degrade gracefully."* `MemoryService`
does exactly that (`embedOrNull`). `DigestsService` does not — so with embeddings off, the whole
request throws *after* up to 40 GitHub calls and 40 model calls have already been spent, and nothing
is persisted.

**Fix:** wrap in try/catch and skip the related-context section, mirroring `MemoryService.embedOrNull`.

### 11. `server/test/digests-service.test.ts` — wrong filename for a DB-backed test

The file imports `test/helpers/pg.js` and starts real Postgres, but is named `*.test.ts`. Per
`server/CLAUDE.md` (*"A DB-backed test **must** be named `*.it.test.ts` or the unit/integration split
silently miscategorizes it"*) and `TESTING.md`, this lands in the unit lane
(`vitest run --exclude '**/*.it.test.ts'`), where it will try to start Docker, and is *excluded*
from the integration lane (`vitest run .it.test`), where it should run.

**Fix:** rename to `server/test/digests.it.test.ts`.

### 12. `server/test/digests-service.test.ts:31` — `new MockLLMProvider('openrouter')` does not compile

`MockLLMProvider`'s constructor accepts only `'openai' | 'anthropic'`
(`server/src/adapters/mocks.ts:58-67`). This is a documented trap —
`server/INSIGHTS.md` 2026-08-22: *"`MockLLMProvider` cannot be constructed as `'openrouter'` — inject
it by KEY instead"*, because `Container.llm(id)` resolves the override by key and never reads
`provider.id`.

**Fix:** `llm: { openrouter: new MockLLMProvider() }`. Do not widen the shared mock.

---

## Medium

### 13. `server/src/modules/digests/repository.ts:24-40` — `findByPeriod` contradicts its own doc comment

The comment says *"Periods are matched on their exact boundaries rather than by overlap"*, but the
query is `gte(periodStart, periodStart)` + `lte(periodEnd, periodEnd)` — **containment**. A narrower
digest (a weekly one) inside a wider requested window (a monthly one) is returned as a cache hit,
and `routes.ts:43` then **deletes** it on `regenerate`. There is also no `.limit(1)` and no
`orderBy`, so which of several matching rows comes back is non-deterministic.

**Fix:** `eq(t.digests.periodStart, periodStart)` + `eq(t.digests.periodEnd, periodEnd)`, plus
`.limit(1)`. If containment is actually wanted, say so in the comment and stop deleting the match.

### 14. `server/src/modules/digests/routes.ts:33-34` — the cache key changes on every request

```ts
const periodEnd = new Date();
const periodStart = new Date(periodEnd.getTime() - req.body.periodDays * 86_400_000);
```

With an exact-boundary lookup (#13, once fixed) this never hits, because `periodEnd` is a fresh
millisecond timestamp each call — the module's stated "never billed twice" guarantee is unreachable.

**Fix:** truncate the window to a UTC day boundary, or key the lookup on `(periodDays, day)` rather
than raw timestamps.

### 15. `server/src/modules/digests/service.ts:67-78` — up to 80 sequential network round-trips inside one POST

One GitHub `getPullRequest` **and** one LLM `complete` per PR, sequentially, bounded only by
`MAX_PRS_PER_DIGEST = 40`, on a synchronous request with **no rate limit on the route**. Compare
`reviews/routes.ts`, which caps `POST /pulls/:id/review` at 10/min with the comment *"each call can
fan out to expensive LLM runs"* — the same reasoning applies here with more force.

**Fix:** add `config: { rateLimit: { max: …, timeWindow: '1 minute' } }` to the route at minimum;
better, run the build through `container.jobs` / `JobRunner` like other long operations, and bound
concurrency rather than serialising 80 calls.

### 16. `server/src/modules/digests/service.ts:57-60` — assumes every merged PR is in one repo

`repoRow` is looked up from `merged[0].repoId` only, then used as the `owner`/`name` for **every**
subsequent `getPullRequest` call. A workspace with two imported repos will fetch PR #17 of repo A
using repo B's coordinates — wrong body text in the digest, or a 404.

**Fix:** join the repo into the merged-PR query, or group PRs by `repoId` and resolve the ref per group.

### 17. `server/src/modules/memory/service.ts:48` — the "must never fail the read" touch can fail the read

```ts
await this.repo.markUsed(rows.map((r) => r.id));
```

`memory/repository/item.repo.ts:21` states the contract explicitly: *"Recency feeds ranking later;
a failed touch must never fail the read."* Awaited unguarded, a failing `UPDATE` (lock timeout,
read-only replica) rejects the entire search — the one thing this module's doc comment says must not
happen. Minor secondary point: `markUsed` runs before `dedupeByContent`, so suppressed duplicates
still get their recency bumped.

**Fix:** `this.repo.markUsed(ids).catch((err) => req.log?.warn(err))` (fire-and-forget), or a
try/catch; and mark used only the rows actually returned.

### 18. `reviewer-core/src/review/summarize.ts:9-12` — a structured schema that validates nothing

```ts
findings: z.array(z.custom<Finding>()),
```

`z.custom<T>()` with no validator accepts **any** value. The whole point of `completeStructured` is
`toJsonSchema` + `parseWithRepair`; with `z.custom` the generated JSON Schema carries no shape for
the findings array and the repair loop cannot detect a malformed response. A real Zod `Finding`
schema is already exported from `@devdigest/shared`
(`server/src/vendor/shared/contracts/findings.ts:47`).

**Fix:** `import { Finding } from '@devdigest/shared'` and use `z.array(Finding)`.

### 19. `reviewer-core/src/review/summarize.ts:7,66` — model hardcoded inside the engine

`const SUMMARY_MODEL = 'anthropic/claude-3.5-haiku';` — every other engine entry point takes the
model from its input (`ReviewInput.model`) so the consumer's settings / feature-model override
applies. Hardcoding it in the core means the studio's model configuration silently does not govern
this pass. (The same applies to `DIGEST_MODEL` in `digests/constants.ts:8`, but that one at least
lives on the server side where `resolveFeatureModel` is reachable — see `server/INSIGHTS.md`
2026-08-11 on the intent module.)

**Fix:** add `model: string` to `SummarizeInput`; keep the constant as an exported default.

### 20. `server/src/modules/digests/service.ts:53-54` — a quiet week returns 404

`throw new NotFoundError('No pull requests were merged in this period')` turns "nothing merged" into
an error status. Nothing is missing; the answer is an empty digest.

**Fix:** return an empty-but-valid digest, or a 200 with an explicit `empty: true` flag the UI can render.

---

## Low

### 21. `server/src/modules/digests/service.ts:43-48` — `periodEnd` is accepted but never applied

The window filter is `gte(t.pullRequests.updatedAt, periodStart)` with no upper bound, so a digest
built for a historical window would include everything merged since. Latent only because `routes.ts`
always passes `now` as `periodEnd`. Add `lte(t.pullRequests.updatedAt, periodEnd)`.

### 22. `server/src/modules/digests/service.ts:51` — silent truncation

`MAX_PRS_PER_DIGEST = 40` truncates without telling the reader. Its own comment says a longer digest
"stops being readable", which is fine — but append a "+N more" line so the omission is visible.

### 23. `server/test/digests-service.test.ts:9-13,43-78` — the test does not test what its docstring claims

The file comment promises *"a second request for the same window reuses the stored row rather than
rebuilding"* — the module's headline behaviour and the subject of findings #13/#14 — but there is
only one `POST /digests` and no `cached: true` assertion. Add the second request, assert
`cached === true`, and assert `rows` is still length 1.

### 24. Missing unit tests for the two pure helpers, and none at all for `memory`

`digests/helpers.ts` and `memory/helpers.ts` are deliberately I/O-free ("so it is unit-testable on
its own") yet neither has a test, and the whole `memory` module — routes, service, repository,
`dedupeByContent` — is untested. The repo convention is a `*-helpers.test.ts` unit file per module
(`blast-helpers.test.ts`, `reviews-helpers.test.ts`, `intent-helpers.test.ts`, …). These are the
cheapest tests in the PR; `dedupeByContent`'s normalisation and the embed-failure degradation path
in `MemoryService.search` are both worth pinning.

### 25. `server/src/modules/memory/service.ts:57-64` — silent bare catch

`embedOrNull` swallows every error including programming ones, with no log line. The graceful
degradation is right; make it observable — log at `warn` so a mis-provisioned embedder is
diagnosable rather than appearing as "search returns nothing".

---

## What is good — and what I deliberately did not flag

The `memory` module is the model the `digests` module should follow, and most of it needs no change:

- `memory/routes.ts` is genuinely presentation-only — Zod schema, `getContext`, one service call,
  response shaping, no repository import, no branching.
- `memory/repository.ts` is a textbook facade-over-aggregate split (`item.repo.ts` for writes,
  `search.repo.ts` for vector search), with a clear rationale in its doc comment for why the two
  files have different reasons to change. This matches `reviews/repository.ts` exactly.
- `MemoryService.embedOrNull` correctly implements the container's documented degrade-gracefully
  contract for `embedder()`.
- Splitting tunables into `constants.ts` and pure shaping into `helpers.ts` is proportionate and
  keeps the services thin.
- Both modules' Zod validation goes through `fastify-type-provider-zod` route schemas rather than
  hand-rolled `Schema.parse(req.body)`, per `server/CLAUDE.md`.

Per `guides/pitfalls-and-tradeoffs.md`, these are **not** findings and should not be "fixed":

- Both services taking the whole `Container` in their constructor (`digests/service.ts:27`,
  `memory/service.ts:30`) — the documented, accepted convenience trade-off.
- `DigestRow` / `MemoryRow` being `$inferSelect` row types used as DTOs — schema-shaped domain types
  are a deliberate compromise here, not an anemic-domain smell.
- `OpenRouterProvider` physically living inside `reviewer-core` — the documented exception. The
  finding in #1 is about *constructing* it in `summarize.ts`, not about where the class lives.
- `digests` having no `repository/<aggregate>.repo.ts` split — one aggregate, correctly unsplit.
