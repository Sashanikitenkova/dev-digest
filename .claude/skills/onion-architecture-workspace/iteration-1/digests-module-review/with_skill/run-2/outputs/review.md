# Review — new `server/src/modules/digests/`

Reviewed against the `onion-architecture` skill (SKILL.md + all five guides), `server/CLAUDE.md`, the root `CLAUDE.md`, and the existing modules the skill names as canonical (`reviews/`, `brief/`, `risks/`, `settings/`).

Verdict: **request changes.** The module cannot work as written (C1), and three of the four layering rules the skill enforces are broken in `service.ts` and `routes.ts`. There are also two data-loss/correctness bugs in the cache-and-regenerate path.

File paths below are relative to `server/src/modules/digests/` unless stated otherwise.

---

## Critical

### C1. The digest can never be built — `OpenRouterProvider` has no `complete()`

`service.ts:59-70`

```ts
const llm = await this.container.llm('openrouter');
...
const result = await llm.complete({ model: DIGEST_MODEL, messages: [...] });
```

`container.llm('openrouter')` resolves to `OpenRouterProvider` (`server/src/platform/container.ts:187-197`), and that class implements exactly one method:

```ts
// reviewer-core/src/llm/openrouter.ts:25
const NOT_SUPPORTED = 'OpenRouterProvider only implements completeStructured';
// reviewer-core/src/llm/openrouter.ts:196-198
async complete(_req: CompletionRequest): Promise<CompletionResult> {
  throw new Error(NOT_SUPPORTED);
}
```

So `POST /digests` throws on the very first PR, every time. This is not a style issue — the feature is non-functional.

**Fix:** call `completeStructured` with a one-field Zod schema (`{ summary: string }`), the way `brief/service.ts:236-247` does, or resolve a provider that actually implements `complete` (see M3 — `openai`/`anthropic` do). Either way, add a test that runs the service against a stubbed provider implementing the real `LLMProvider` interface; a hand-rolled `{ complete: vi.fn() }` mock would hide exactly this bug.

### C2. `service.ts` imports and constructs a concrete adapter

`service.ts:2` and `service.ts:58`

```ts
import { OctokitGitHubClient } from '../../adapters/github/octokit.js';
...
const github = new OctokitGitHubClient(process.env.GITHUB_TOKEN ?? '');
```

Direct Dependency Rule violation. Per `guides/layer-model.md` and `guides/fastify-routing-and-di.md`, `platform/container.ts` is the only file allowed to import from `adapters/*` — it is the sole importer of `OctokitGitHubClient` today (`container.ts:16`). This is the exact "bad" example in `fastify-routing-and-di.md` §Good vs bad #1.

The practical cost: `ContainerOverrides.github` (`container.ts:44`) can no longer intercept the client, so this code path is untestable without live GitHub network access — and the PR ships no tests at all (M2), so nothing catches it.

**Fix:** `const github = await this.container.github();` and delete the import.

### C3. Secrets read from `process.env`, bypassing `SecretsProvider`

`service.ts:58` — `process.env.GITHUB_TOKEN ?? ''`

Root `CLAUDE.md`: "Secrets (LLM/GitHub keys) live in `~/.devdigest/secrets.json` (mode 0600), never `.env`/DB." `server/CLAUDE.md` repeats it. `container.github()` resolves the token through `SecretsProvider` and throws `ConfigError('GITHUB_TOKEN is not configured')` when it is missing (`container.ts:161-168`).

The `?? ''` fallback is worse than the bypass itself: with no token it silently builds an **unauthenticated** Octokit, which 404s on every private repo and is capped at 60 requests/hour — surfacing as a confusing "PR not found" instead of a clear config error. It also skips the container's client caching and `invalidateSecretCaches()` (`container.ts:222-226`), so a newly saved PAT is never picked up here.

**Fix:** same as C2 — `await this.container.github()`.

---

## High

### H1. Every PR is fetched from the *first* PR's repository

`service.ts:51-54` and `service.ts:63`

```ts
const [repoRow] = await this.container.db
  .select({ owner: t.repos.owner, name: t.repos.name })
  .from(t.repos)
  .where(eq(t.repos.id, merged[0]!.repoId));
...
const detail = await github.getPullRequest({ owner: repoRow.owner, name: repoRow.name }, pr.number);
```

The window is workspace-scoped (`service.ts:39`), and a workspace routinely holds several repos. The repo is resolved once from `merged[0]` and then applied to every PR in the loop, so PR #42 from `acme/web` is fetched as `acme/api#42` — either a 404 that kills the whole digest, or, worse, a *different real PR* whose body gets summarised under the wrong title. Silent wrong output.

Two secondary problems in the same query: it is not workspace-scoped (`eq(t.repos.id, ...)` only — every other module scopes repo reads, cf. `brief/repository.ts:65-72`), and `merged[0]!` uses a non-null assertion that is only safe because of the check three lines above.

**Fix:** join the repo per PR in the repository (`innerJoin(t.repos, eq(t.repos.id, t.pullRequests.repoId))`, exactly the shape of `brief/repository.ts:65-72`), return `{ pull, repo }` rows, and use each PR's own repo in the loop.

### H2. `service.ts` queries Drizzle directly and imports `db/schema.js`

`service.ts:1`, `service.ts:5`, `service.ts:26-45`, `service.ts:51-54`

The module already has a `repository.ts`, and the skill's rule is unambiguous (`SKILL.md` Quick Reference; `guides/drizzle-repository-pattern.md` §"Repository owns all Drizzle access", whose "bad" example is literally *"a service or route file with `import * as t from '../../db/schema.js'` and its own `db.select()...` inline"*). `reviews/repository.ts` states the invariant in its own doc comment; `brief/repository.ts:8-18` restates it ("nothing else writes this table and this repository reads nothing else's… Only this file may reach the schema for this domain").

Note the precedent that *does* apply: `brief/repository.ts:14-18` documents that a plain workspace-scoped read of the PR + its repo row from *its own repository* is house-legal. So the query belongs in `DigestsRepository`, not in a new module.

**Fix:** add `mergedInPeriod(workspaceId, periodStart, periodEnd, limit): Promise<PullWithRepo[]>` to `repository.ts`, drop `drizzle-orm` and `db/schema.js` from `service.ts`.

### H3. `routes.ts` owns the data layer and the business workflow

`routes.ts:6`, `routes.ts:28`, `routes.ts:33-46`, `routes.ts:52`

```ts
const repo = new DigestsRepository(app.container.db);
...
const existing = await repo.findByPeriod(workspaceId, periodStart, periodEnd);
if (existing && !req.body.regenerate) return { digest: existing, cached: true };
if (existing) await repo.deleteById(workspaceId, existing.id);
const digest = await service.build(...);
```

Routes are presentation-only: validate → call service → shape response (`SKILL.md`; `guides/fastify-routing-and-di.md` §"Routes are presentation-only", whose "bad" example is a handler with inline branching plus direct repo calls). Compare `risks/routes.ts:20-24` — one `getContext`, one service call, done. Here the route does the period-window arithmetic (domain policy), the cache decision, the invalidation, and two direct repository calls; `GET /digests` never touches the service at all. `DigestsService.build()` is left as a thin fragment that can't be tested against the behaviour that actually matters (cached vs rebuilt).

**Fix:** expose `service.generate(workspaceId, { periodDays, regenerate })` and `service.listRecent(workspaceId, limit)`; move the window computation and the cache/regenerate decision into the service; delete `DigestsRepository` from `routes.ts` entirely.

### H4. Regenerate destroys the existing digest before the new one exists

`routes.ts:42-46`

```ts
if (existing) await repo.deleteById(workspaceId, existing.id);
const digest = await service.build(workspaceId, periodStart, periodEnd);
```

`build()` can throw for several reasons — `NotFoundError` (`service.ts:48`, `service.ts:56`), a GitHub failure, an LLM failure, and today *always* (C1). When it does, the digest the user already had is gone and they get a 500. There is no transaction around delete+insert.

**Fix:** build first, then replace inside one `db.transaction`, or add a unique key on `(workspace_id, period_start, period_end)` and upsert.

### H5. `findByPeriod` contradicts its own doc comment and matches the wrong row

`repository.ts:14-20` vs `repository.ts:24-40`, together with `routes.ts:32-36`

The doc comment says: *"Periods are matched on their exact boundaries… only an exact re-request counts as a rebuild of the same digest."* The query does the opposite — `gte(periodStart, periodStart)` + `lte(periodEnd, periodEnd)` is a **containment** match: it returns any digest whose window sits *inside* the requested window.

That interacts badly with `routes.ts:32-33`, where `periodEnd = new Date()` is the wall clock at request time. Two consequences:

1. A true cache hit is impossible — the boundaries are never identical twice — so a "cached" digest is by definition one built for a *different, narrower* period, returned to the caller as `{ cached: true }` for this period.
2. On `regenerate`, `deleteById` (H4) deletes that arbitrary older digest — e.g. yesterday's 7-day digest gets destroyed by today's request.

There is also no `orderBy` and no `.limit(1)`, so which row comes back is whatever Postgres hands over first.

**Fix:** normalize the window before it becomes a key (truncate to whole UTC days, derived in the service per H3), match with `eq()` on both boundaries per the stated contract, and add `.limit(1)`.

---

## Medium

### M1. The module is never registered — the PR ships dead code

`server/src/modules/index.ts:32-49` has no `digests` entry, and the fixture adds none. Per `SKILL.md` ("registered once in `modules/index.ts` — no bypassing the static registry") and the registry's own instructions at `modules/index.ts:23-26`, a module needs one import plus one entry. Without it, neither route is reachable.

**Fix:** `import digests from './digests/routes.js';` plus `digests,` in the `modules` object.

### M2. No tests

The fixture contains five source files and zero tests. `TESTING.md` asks for hermetic unit tests plus "one real integration per data-backed workflow", and `server/CLAUDE.md` warns that a DB-backed test **must** be named `*.it.test.ts`. Server tests live in `server/test/`.

Note the coupling to C2/C3: as written, the service cannot be unit-tested at all, because the GitHub client is `new`ed from `process.env` rather than injected. Fixing C2 makes the test possible.

**Minimum to add:** `test/digests-helpers.test.ts` for `renderDigestMarkdown`; a service test with `ContainerOverrides.github` + `.llm` stubs covering the multi-repo case (H1) and a per-PR failure; `test/digests.it.test.ts` covering cache-hit, regenerate, and the empty window.

### M3. Model and provider are hardcoded instead of resolved per workspace

`constants.ts:8` (`DIGEST_MODEL = 'anthropic/claude-3.5-haiku'`) and `service.ts:59` (`llm('openrouter')`).

The established convention for system LLM features is the `FEATURE_MODELS` registry (`server/src/vendor/shared/contracts/platform.ts:43-79`) resolved through `resolveFeatureModel(container, workspaceId, id)` (`settings/feature-models.ts:50-57`), whose doc states the registry defaults *mirror* each module's old constant. `intent`, `conventions` and `brief` all do this (`brief/service.ts:236-237`). A hardcoded provider+model means the digest is invisible in the settings UI and unswitchable.

**Fix:** add a `digest` entry to `FEATURE_MODELS` with this constant as its default, then `const choice = await resolveFeatureModel(...); const llm = await this.container.llm(choice.provider);`. This is also the cleanest route out of C1, since `OpenAIProvider`/`AnthropicProvider` do implement `complete`.

### M4. Unbounded sequential N+1 with no error isolation and no cost accounting

`service.ts:61-72`

Up to `MAX_PRS_PER_DIGEST` (40) GitHub round-trips **and** 40 model calls, strictly sequential, inside a single HTTP request. Nothing bounds concurrency, nothing sets a timeout, and one failing PR aborts the loop — discarding every already-billed completion before it. Nothing is persisted until line 74, so a failure at PR 39 costs 38 paid calls and produces nothing.

Also: `result.tokensIn/tokensOut/costUsd` are discarded. Every other LLM caller in the codebase attributes cost (`brief/service.ts`, the reviews run-executor via `agent_runs`/`run_traces`), so digests will be a silent hole in spend tracking.

**Fix:** bound concurrency (a small pool), wrap each PR in try/catch and degrade to a placeholder line rather than failing the digest, record tokens/cost, and consider running the build through `container.jobs` rather than blocking the request.

### M5. An empty period returns 404

`service.ts:47-49` throws `NotFoundError('No pull requests were merged in this period')`.

"Nothing merged last week" is a legitimate empty state, not a missing resource — and the client cannot distinguish it from "this digest does not exist". Note `repo-intel`'s documented "degrade gracefully" convention (`guides/layer-model.md` §Facades): an unindexed repo returns empty results rather than throwing.

**Fix:** return a digest with an empty body (or a 200 with an explicit `{ empty: true }`), and reserve 404 for a genuinely missing digest id.

### M6. The merged-in-window filter is wrong at both ends

`service.ts:40-42`

- Only `gte(updatedAt, periodStart)` — no `lte(..., periodEnd)`. Harmless while `periodEnd` is `now`, but it silently becomes a bug the moment anyone asks for a historical window, which is the obvious next feature.
- `pullRequests.updatedAt` (`server/src/db/schema/pulls.ts:28`) mirrors GitHub's `updated_at`, not a merge timestamp — there is no `merged_at` column. A PR merged two months ago but commented on yesterday lands in this week's digest.
- `updatedAt` is nullable, so PRs with a null value are silently excluded.

**Fix:** add the upper bound, and add a comment stating that `updatedAt` is a deliberate proxy for merge time until a `merged_at` column exists.

---

## Low

### L1. `POST /digests` with no body 400s

`routes.ts:9-12`, `routes.ts:30`. Every field has a `.default()`, so the endpoint reads as "body optional" — but an absent body validates `undefined` against an object schema and fails before the handler runs. `reviews/routes.ts` handles this with `RunRequest.parse(req.body ?? {})`.

**Fix:** keep the route schema (per `server/CLAUDE.md`: validate via Zod route schemas) but make the body tolerate absence, e.g. `GenerateBody.default({})`.

### L2. No uniqueness or index behind the cache key

`server/src/db/schema/ops.ts:41-50`. The `digests` table has no index on `workspace_id` and no unique constraint on the period. Two concurrent `POST /digests` calls both miss the cache and both insert, producing duplicate digests for one window (and two paid model runs). `listRecent` also orders by a nullable `period_end`.

**Fix:** if a migration is in scope, add `unique(workspace_id, period_start, period_end)` + a `workspace_id` index and turn the cache path into an upsert — which also dissolves H4.

### L3. Raw rows returned as the API contract

`repository.ts:5`, `routes.ts:39/52`. Row-types-as-DTOs is a documented, accepted compromise here (`guides/drizzle-repository-pattern.md` §"Row types are DTOs") — not a bug. But `periodStart`, `periodEnd` and `bodyMd` are all nullable in the schema while the response implies non-null, and peer modules return a shared contract type instead (`risks/routes.ts:21` → `Promise<Risks>`).

**Fix:** consider a small `Digest` contract in `vendor/shared/contracts` so the client gets a stable non-nullable shape.

### L4. Digest headings shift with the server's timezone

`helpers.ts:3` — `new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' })` with no `timeZone`. The same digest renders "3 Mar" or "4 Mar" depending on the host. Pass `timeZone: 'UTC'` (and the same normalization the window keys use, per H5).

---

## Checked and found clean — do not "fix" these

- **`constants.ts` and `helpers.ts` are not stray files.** `brief/`, `risks/` and `settings/` all carry the same pair; a pure, I/O-free `helpers.ts` is the house pattern, and `helpers.ts` here is genuinely pure. No change needed.
- **`DigestsService` taking the whole `Container`** (`service.ts:21`) is a documented, accepted compromise (`guides/pitfalls-and-tradeoffs.md` §"descriptive, not aspirational"), matching `ReviewService`/`RisksService`. Not a finding.
- **`repository.ts` shape is right** — takes `Db`, is the only intended holder of `db/schema` access for this domain, and `deleteById` is correctly workspace-scoped (`repository.ts:56-60`). Its problems are the query semantics (H5), not its layering.
- **The grounding gate does not apply here.** `groundFindings()` is mandatory for diff-anchored `Review`/`Finding` data (`guides/reviewer-core-llm-port.md`); a prose digest is not that, so its absence is correct.
- **Layering depth is proportionate.** A single-aggregate `repository.ts` with no facade-over-`*.repo.ts` split is right for this domain (`guides/pitfalls-and-tradeoffs.md` §"When not to add a new layer").

---

## Suggested order of work

1. C2 + C3 (route GitHub through `container.github()`) — unblocks testability.
2. C1 + M3 (feature-model resolution + `completeStructured`) — makes the feature run at all.
3. H2 + H1 (move queries into the repository, join the repo per PR).
4. H3 + H4 + H5 (workflow into the service, normalized period key, build-then-replace).
5. M1 (register the module), M2 (tests), then the remaining Medium/Low items.
