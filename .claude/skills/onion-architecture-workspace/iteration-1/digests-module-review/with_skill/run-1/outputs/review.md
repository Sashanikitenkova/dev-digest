# Review — new `server/src/modules/digests/` module

Reviewed against the `onion-architecture` skill (`SKILL.md` + all five guides), the
existing `server/` module corpus, and the live schema/migrations.

Paths below are relative to `server/src/modules/digests/`; line numbers are the
fixture's own.

**Verdict: request changes.** Two Dependency-Rule violations (both Critical), one
route-layer violation, an unregistered module, and a caching bug that makes the
module re-bill every model call on every request.

---

## Critical

### 1. `service.ts:2,58` — the service imports and constructs a concrete adapter, and reads the token from `process.env`

```ts
 2  import { OctokitGitHubClient } from '../../adapters/github/octokit.js';
...
58  const github = new OctokitGitHubClient(process.env.GITHUB_TOKEN ?? '');
```

Three separate problems in one line:

- **Composition-root violation.** `server/src/platform/container.ts` is the only
  file allowed to import from `server/src/adapters/*` — verified: it is currently
  the only importer of `OctokitGitHubClient`. `guides/layer-model.md` states this
  as a hard rule ("If you find yourself importing from `server/src/adapters/*`
  anywhere outside `container.ts`, that's a Dependency Rule violation"), and
  `guides/fastify-routing-and-di.md` uses almost exactly this line as its
  canonical *bad* example.
- **It bypasses `SecretsProvider` and will silently use the wrong token.**
  `adapters/secrets/local.ts` reads `~/.devdigest/secrets.json` **first** and only
  falls back to `process.env` — "Stored values take precedence over env so a key
  entered in the UI wins." A user who entered their PAT in the studio UI (the
  documented path; `CLAUDE.md`: secrets "live in `~/.devdigest/secrets.json`,
  never `.env`/DB") gets `process.env.GITHUB_TOKEN === undefined` here, so the
  `?? ''` constructs an **unauthenticated** Octokit. The failure mode is a 401 or
  a 60-req/hr rate-limit error mid-loop, not a clear "token not configured".
  `container.github()` throws `ConfigError('GITHUB_TOKEN is not configured')`
  instead, which is the correct behaviour.
- **It makes the module untestable.** `ContainerOverrides.github` is how every
  other module's tests inject a mock GitHub client; constructing the adapter
  inline routes around it, so any test of `DigestsService.build` needs live
  network access.

**Fix:** delete the import and use the port:

```ts
const github = await this.container.github(); // typed GitHubClient
```

(and resolve it once outside the loop, as written).

### 2. `service.ts:1,5,26–56` — the service issues raw Drizzle queries instead of going through a repository

```ts
 1  import { and, desc, eq, gte } from 'drizzle-orm';
 5  import * as t from '../../db/schema.js';
...
26  const merged = await this.container.db.select({...}).from(t.pullRequests)...
51  const [repoRow] = await this.container.db.select(...).from(t.repos)...
```

`guides/drizzle-repository-pattern.md` names this exact shape as the bad example
("a service or route file with `import * as t from '../../db/schema.js'` and its
own `db.select().from(...)` inline"). This is not an aspirational rule here — I
checked every service in the repo: **no `modules/*/service.ts` imports
`db/schema.js`**, and all eleven that touch data do
`this.repo = new XRepository(container.db)` and nothing else. The digests service
already constructs a `DigestsRepository` on line 22 and then reaches past it.

Note this also means the module's own repository doc comment ("Digest persistence
— reads and writes over the `digests` table") understates what the module does:
the PR/repo reads have no owner at all.

**Fix:** move both queries onto `DigestsRepository` — e.g.
`listMergedInPeriod(workspaceId, periodStart, periodEnd, limit)` and
`getReposByIds(workspaceId, ids)` — and have `build()` call those. `server/src/db/rows.ts`
already exports `PullRow` if a full row is wanted.

(The `pulls` module's route-level `container.db` queries are an older outlier in a
module that has no service or repository at all — not a precedent to copy into a
module that ships both.)

---

## High

### 3. `routes.ts:6,28,33–46` — the route owns the business logic and talks to the repository directly

```ts
 6  import { DigestsRepository } from './repository.js';
28  const repo = new DigestsRepository(app.container.db);
...
33  const periodEnd = new Date();
34  const periodStart = new Date(periodEnd.getTime() - req.body.periodDays * 24*60*60*1000);
36  const existing = await repo.findByPeriod(workspaceId, periodStart, periodEnd);
38  if (existing && !req.body.regenerate) return { digest: existing, cached: true };
42  if (existing) await repo.deleteById(workspaceId, existing.id);
46  const digest = await service.build(...);
```

`SKILL.md`'s checklist: "`routes.ts` is presentation-only: Zod validation → one or
more service calls → response shaping. No direct repository/adapter calls, no
business branching." Everything the digest feature actually *decides* — what the
period window is, whether a cached digest counts, whether to rebuild, and the
delete-then-rebuild sequencing — lives in the handler. `guides/fastify-routing-and-di.md`
flags the consequence explicitly: this can only be tested by standing up a full
Fastify instance, whereas the same logic on the service is a plain method call.

**Fix:** collapse lines 33–47 into one service call, e.g.
`service.generate(workspaceId, { periodDays, regenerate })` returning
`{ digest, cached }`; drop the `DigestsRepository` import and the `repo` local from
the route entirely. `GET /digests` should likewise call `service.list(workspaceId, limit)`.
Compare `reviews/routes.ts`, which is parse → one/two service calls → shape.

### 4. Module is never registered — as shipped, none of this is reachable

`server/src/modules/index.ts` is a static registry ("ADD A MODULE: create
`modules/<name>/routes.ts` exporting a default Fastify plugin, then add one import
+ one entry below"), and `app.ts:194` registers only `Object.values(modules)`. The
PR adds no import and no entry, so `POST /digests` and `GET /digests` 404. The
skill checklist calls this out: "registered once in `modules/index.ts` — no ad hoc
extra top-level files, no bypassing the static registry."

**Fix:** add `import digests from './digests/routes.js';` and a `digests,` entry to
the `modules` object. (No migration is needed — the `digests` table already exists
in `db/schema/ops.ts:41` and `migrations/0000_init.sql:107`.)

### 5. `repository.ts:24–40` — `findByPeriod` does not do what its doc comment says, and the cache never hits

The doc comment on lines 17–19 says "Periods are matched on their exact boundaries
rather than by overlap … only an exact re-request counts as a rebuild." The query
does the opposite of exact matching:

```ts
33  gte(t.digests.periodStart, periodStart),
34  lte(t.digests.periodEnd, periodEnd),
```

That is *containment* — "any digest whose window falls inside the requested
window" — not equality. Combined with `routes.ts:33`'s `periodEnd = new Date()`
(a fresh millisecond-precision timestamp on every request), the practical result
is that a digest built an hour ago has `periodStart` **earlier** than today's
`now − 7d`, so `gte` fails and the lookup misses. The stated purpose of the whole
module ("Building one costs a model call over every merged PR in the window, so a
digest for a period that was already built is reused" — `routes.ts:20–23`; "so the
same period is never billed twice" — `service.ts:15–16`) therefore never holds:
**every POST re-runs up to 40 GitHub calls and 40 model calls.**

**Fix:** two changes together — (a) use `eq` on both boundaries to match the
documented semantics, and (b) normalise the window to a stable boundary (e.g.
truncate to UTC midnight) in the service before it is used as a cache key, so two
requests on the same day produce the same key. Also add an ordering + `limit(1)`
so the lookup is deterministic if multiple rows match.

### 6. `routes.ts:42–46` — delete-before-build destroys the previous digest when the rebuild fails, and the check→delete→insert sequence is not atomic

If `service.build()` throws — no PRs merged (line 48 of `service.ts`), no GitHub
token, an LLM timeout, one bad PR fetch — the previously cached digest has already
been deleted on line 43 and is gone. A regenerate that fails should leave the old
digest in place. Separately, two concurrent `POST /digests` calls both read
`existing`, both delete, and both insert: duplicate rows, or one deleting the
other's fresh row. There is no unique constraint on `(workspace_id, period_start,
period_end)` in `migrations/0000_init.sql:107–114` to catch this.

**Fix:** in the service, build first and replace afterwards inside one transaction
(insert-then-delete-old, or a proper upsert). If duplicates must be prevented
across concurrent requests, add a unique index on
`(workspace_id, period_start, period_end)` in a new migration and upsert onto it.

### 7. `service.ts:51–56,63` — single-repo assumption: every PR is fetched from the *first* PR's repository

```ts
54  .where(eq(t.repos.id, merged[0]!.repoId));
...
63  const detail = await github.getPullRequest({ owner: repoRow.owner, name: repoRow.name }, pr.number);
```

A workspace can hold many repos (`repos.workspaceId` + the `repos_ws_fullname_uq`
index), and the PR query on lines 36–45 is scoped by workspace only — not by repo.
So a digest over a two-repo workspace fetches repo B's PR #12 from repo A, which
either 404s or, worse, silently returns *a different PR that happens to share the
number* and summarises it into the digest as if it were the right one. That is a
correctness bug producing plausible-looking wrong output.

**Fix:** load the repos for all distinct `repoId`s (a single `inArray` query on the
repository, workspace-scoped), index them by id, and use each PR's own repo. If
digests are intended to be per-repo, take a `repoId` parameter instead and scope
the PR query to it.

---

## Medium

### 8. `service.ts:63,68` — the GitHub round-trip is unnecessary; the PR body is already in the database

`db/schema/pulls.ts:26` persists `body: text('body')`, and `modules/pulls/routes.ts:260,288`
writes it at import/refresh time. The only thing `detail` is used for is
`detail.body ?? ''` on line 68. So the loop makes N network calls to GitHub — the
main source of latency, rate-limit exposure and the token problem in finding 1 —
to fetch a column the select on lines 27–34 could simply have included.

**Fix:** add `body: t.pullRequests.body` to the (repository-owned) select and drop
the GitHub client from this flow entirely. That also removes finding 1's blast
radius. If a fresher body is genuinely required, say so in a comment and go
through `container.github()`.

### 9. `constants.ts:8` + `service.ts:59,65` — hardcoded model bypasses the per-feature model settings

```ts
 8  export const DIGEST_MODEL = 'anthropic/claude-3.5-haiku';
...
59  const llm = await this.container.llm('openrouter');
```

The house convention for a workspace-visible LLM feature is `FEATURE_MODELS`
(`vendor/shared/contracts/platform.ts:43`) resolved via
`resolveFeatureModel(container, workspaceId, '<id>')` — used by `brief/service.ts:235`,
`intent/service.ts:184`, and conventions/conformance. `settings/feature-models.ts:12–18`
states the intent: "System LLM features … read their provider/model from the
workspace's Settings instead of a hardcoded module constant." A hardcoded constant
plus a hardcoded `'openrouter'` provider means the digest model can't be changed
from the settings UI like every other feature's can.

**Fix:** add a `digest` entry to `FEATURE_MODELS` with `defaultProvider: 'openrouter'`
and `defaultModel: DIGEST_MODEL` (the registry defaults are meant to mirror the
module constant), then
`const choice = await resolveFeatureModel(this.container, workspaceId, 'digest');
const llm = await this.container.llm(choice.provider);` and pass `choice.model`.

### 10. `service.ts:41` — `updatedAt` is used as a merge timestamp, and the window has no upper bound

```ts
41  gte(t.pullRequests.updatedAt, periodStart),
```

Two issues. (a) There is no `lte(t.pullRequests.updatedAt, periodEnd)`, so a
request for a *historical* window silently includes everything since
`periodStart`, including PRs merged after the period ended. (b) `updatedAt` is
last-touched time, not merge time — `db/schema/pulls.ts` has no merged-at column —
so a PR merged three months ago whose row was touched by a poll yesterday lands in
"Merged this week". The digest heading (`helpers.ts:6`, "## Merged \<start\> – \<end\>")
then asserts something the query doesn't establish.

**Fix:** add the `lte` upper bound at minimum. For (b), either add a `mergedAt`
column (migration + populate at import) or document explicitly in the service doc
comment that the window is approximated by `updatedAt`.

### 11. `service.ts:47–49` — an empty period is reported as a 404

```ts
48  throw new NotFoundError('No pull requests were merged in this period');
```

`platform/errors.ts:19` maps `NotFoundError` to HTTP 404 with code `not_found`.
"Nobody merged anything last week" is a valid, successful, empty result — not a
missing resource. The client can't distinguish it from "this route doesn't exist"
or "workspace not found", and `repo-intel`'s documented "degrade gracefully"
convention (unindexed → empty result, not a throw) points the other way.

**Fix:** return a digest with an empty body (or `{ digest: null, cached: false }`)
and let the UI render "no merged PRs in this period".

### 12. `service.ts:62–72` — up to 80 sequential network calls inside one HTTP request, with no timeout and no error containment

The loop makes one GitHub call plus one LLM call per PR, sequentially, up to
`MAX_PRS_PER_DIGEST = 40`. Nothing bounds the total: `llm.complete` is called
without `timeoutMs` or `maxTokens`, where every other LLM caller in the repo sets
one (`brief/service.ts:246` `BRIEF_TIMEOUT_MS`, `intent/service.ts:213`,
`conventions/service.ts:158`). A single failure on PR #37 throws away the 36
model calls already paid for, and it surfaces as a raw provider error rather than
the `ExternalServiceError` wrapper the rest of the codebase uses
(`brief/service.ts:281`).

**Fix:** (a) add `timeoutMs`/`maxTokens` from `constants.ts`; (b) wrap the provider
call so failures surface as `ExternalServiceError`; (c) either catch per PR and
emit a placeholder line so one bad PR doesn't void the digest, or — given the
worst-case wall time — run the build through `container.jobs` like
`repos/service.ts:98` and `repo-intel/routes.ts:53` do, returning a job id.

---

## Low

### 13. `constants.ts:6` + `service.ts:45` — the 40-PR cap is applied silently

`.limit(MAX_PRS_PER_DIGEST)` truncates, but the response and the rendered markdown
say nothing about it. A busy workspace gets a digest that claims to cover the week
and quietly omits PRs, ordered by `updatedAt` rather than by importance.

**Fix:** return a `truncated: true` / `totalMerged` field and/or append a line to
the markdown ("… and N more").

### 14. No tests in the PR

Server tests live in `server/test/` as `*.test.ts` (mocked ports) and `*.it.test.ts`
(real Postgres) — 71 files today. The skill checklist requires test placement to
mirror the ring. Nothing here is covered.

**Fix:** `test/digests-helpers.test.ts` for `renderDigestMarkdown`; a
`test/digests.it.test.ts` for the repository and the cache-hit / regenerate /
empty-period paths, with `ContainerOverrides.github` + `.llm` mocks — which only
becomes possible once findings 1 and 3 are fixed.

### 15. `repository.ts:42–49` and `routes.ts:39,52` — nullable columns and raw rows on the wire

`digests.periodStart`, `periodEnd` and `bodyMd` are all nullable in
`db/schema/ops.ts:46–48`, so `DigestRow` types them `| null` while the module
assumes they're set. Two consequences: `orderBy(desc(t.digests.periodEnd))` puts
NULL rows **first** in Postgres, and the route returns the raw row — including the
unrelated `deliveredTo` column — with no response schema. There is also no index
on `digests(workspace_id, period_end)` to serve `listRecent`.

**Fix:** either tighten the columns to `.notNull()` in a migration or handle null
explicitly; add `.nullsLast()` to the ordering; shape a small DTO in the route;
and add the covering index if digest volume is expected to grow.

### 16. `service.ts:53–54` — the repos lookup is not workspace-scoped

`eq(t.repos.id, merged[0]!.repoId)` has no `workspaceId` predicate. It happens to
be safe today because the id came from a workspace-scoped PR row, but every other
repos read in the codebase carries the tenancy predicate; keep it uniform so the
invariant survives refactors. (Fold this into the repository method from finding 2.)

---

## Checked and clean — do not "fix" these

- **`constants.ts` and `helpers.ts` as extra files.** Proportionate, and precedented:
  `modules/settings/` is `routes.ts` + `feature-models.ts` + `helpers.ts` with no
  repository at all. `guides/pitfalls-and-tradeoffs.md` explicitly warns against
  demanding uniform layering depth. `helpers.ts` being pure and I/O-free is exactly
  right.
- **`DigestsService` taking the whole `Container`** (`service.ts:21`). This is the
  documented, intentional compromise in `guides/pitfalls-and-tradeoffs.md` — not a
  finding.
- **`DigestRow = typeof t.digests.$inferSelect` in `repository.ts:5`.** Row-types-as-DTOs
  is an accepted trade-off here; keeping it in the owning repository rather than
  `db/rows.ts` is correct while digests has no cross-cutting consumer.
- **`this.repo = new DigestsRepository(container.db)` in the service constructor**
  (`service.ts:22`) matches all eleven existing services.
- **`getContext` for tenancy** (`routes.ts:31,51`) — the right shared helper.
- **The grounding gate does not apply.** `groundFindings()` is the invariant for
  diff-anchored `Finding` data; digests produce prose summaries with no line
  citations, so there is nothing to ground. (If digests ever start emitting
  file/line references, that changes.)
- **No migration needed.** The `digests` table already exists in `0000_init.sql`;
  the PR correctly adds none. (Findings 6 and 15 would each add one.)

---

## Suggested order of work

1. Findings 1 + 8 together — dropping the GitHub call removes the adapter import
   and the `process.env` read in one move.
2. Finding 2 — move both queries onto `DigestsRepository`.
3. Finding 3 — move the period/cache/regenerate logic into `DigestsService`.
4. Findings 5 + 6 — fix the cache key and make replace atomic.
5. Finding 4 — register the module.
6. Finding 7 — per-PR repo resolution.
7. The rest, then finding 14's tests, which the first three make cheap to write.
