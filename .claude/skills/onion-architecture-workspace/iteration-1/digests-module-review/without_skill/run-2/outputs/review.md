# PR review — `server/src/modules/digests/`

Reviewed as if the fixture files were `server/src/modules/digests/{constants,helpers,repository,routes,service}.ts`,
against the conventions the other 16 modules in `server/src/modules/` already follow
(`server/CLAUDE.md`, `server/INSIGHTS.md`, `TESTING.md`).

**Verdict: request changes.** The module inverts the repo's layering in two places, constructs an
adapter itself with a `process.env` secret, and contains a correctness bug that will summarise the
wrong repository's pull requests in any workspace with more than one repo. The pure helper
(`helpers.ts`) and the general shape (routes/service/repository/constants/helpers) are right; the
wiring is not.

---

## Blocking

### 1. The route drives the repository and owns the business logic — `routes.ts:28, 33-34, 36, 42-46, 52`

```ts
const service = new DigestsService(app.container);
const repo = new DigestsRepository(app.container.db);   // :28
```

The route then computes the period (`:33-34`), decides the cache hit (`:38`), deletes the old row
(`:43`) and reads the list (`:52`) straight off the repository. That is three layers collapsed into
the transport layer.

Every other module in this codebase does the opposite: routes construct **only** the service, and a
repository is constructed **only** inside a service (or in `platform/container.ts` for the shared
ones). Eleven call sites, no exceptions — `repos/service.ts:37`, `context/service.ts:42`,
`agents/service.ts:55`, `intent/service.ts:76`, `risks/service.ts:20`, `smart-diff/service.ts:23`,
`blast/service.ts:31`, `brief/service.ts:146`, `conventions/service.ts:87`,
`repo-intel/service.ts:105`, `reviews/service.ts:34`. `conventions/routes.ts` is the closest
comparable module and touches nothing but `ConventionsService`.

**Do:** give the service `generate(workspaceId, { periodDays, regenerate })` and
`list(workspaceId, limit)`. Move the period arithmetic, the cache decision and the rebuild into
`service.ts`. The route should resolve context, validate, call one service method, return.
Delete the `DigestsRepository` import from `routes.ts` entirely.

### 2. The service builds its own GitHub adapter from `process.env` — `service.ts:2, 58`

```ts
const github = new OctokitGitHubClient(process.env.GITHUB_TOKEN ?? '');
```

Three separate violations in one line:

- **Adapters are constructed in `platform/container.ts`, nowhere else.** The container exists so
  services depend on the `GitHubClient` interface and tests swap in `MockGitHubClient` via
  `ContainerOverrides.github` (`platform/container.ts:44`, `adapters/mocks.ts`). No module
  constructs an adapter class; the only `adapters/*` imports from `modules/` are pure functions
  (`approxTokens`, `parseUnifiedDiff`, ast-grep helpers). As written, this module cannot be tested
  hermetically and **will make live GitHub calls from the test suite** — the exact failure mode
  recorded in `server/INSIGHTS.md` (2026-08-11, "an integration test that injects only SOME
  providers silently hits the real network").
- **Secrets never come from `process.env` in module code.** `server/CLAUDE.md`: "Secrets resolve
  through `SecretsProvider` (`~/.devdigest/secrets.json`) — not `AppConfig`/`.env`."
- **`?? ''` swallows the misconfiguration.** `Container.github()` throws
  `ConfigError('GITHUB_TOKEN is not configured')` up front; this sends an empty token and surfaces
  as an opaque 401 from Octokit halfway through a 40-PR loop.

**Do:** `const github = await this.container.github();`

### 3. The service queries the database directly — `service.ts:1, 5, 26-45, 51-54`

`DigestsService` imports `drizzle-orm` and `db/schema.js` and runs two `select()` chains against
`t.pullRequests` and `t.repos` on `this.container.db`, while a `DigestsRepository` sits right next
to it holding only the trivial queries.

No service in this codebase does this: `grep` for `db/schema` under `modules/` returns
repositories, `_shared/schemas.ts`, three route files that predate the split, and
`settings/feature-models.ts` — no `*/service.ts`. Data access is the repository's job, and this is
what makes workspace scoping auditable in one place.

**Do:** add `listMergedInPeriod(workspaceId, periodStart, periodEnd, limit)` and a repo lookup to
`repository.ts` (or reuse existing repo data-access), and let the service compose.

### 4. Correctness bug: every PR is fetched from the first PR's repository — `service.ts:51-63`

```ts
const [repoRow] = await this.container.db.select({...}).from(t.repos)
  .where(eq(t.repos.id, merged[0]!.repoId));      // :54
...
for (const pr of merged) {
  const detail = await github.getPullRequest({ owner: repoRow.owner, name: repoRow.name }, pr.number);  // :63
```

`merged` is scoped by workspace, not by repo, and a workspace holds many repos (`repos` table,
`pr_repo_number_uq` is `(repo_id, number)` — PR numbers are only unique *per repo*). For any
workspace with two or more imported repos this fetches `owner/name#123` from the wrong repository:
either a 404 that aborts the whole digest, or — worse and silent — a real but completely unrelated
PR whose body gets summarised into the digest under the right PR's number and author.

**Do:** the GitHub call is not needed at all. `pull_requests.body` is already persisted
(`db/schema/pulls.ts:27`) by the importer. Read the body from the row and drop `github` from this
service; if the live body is genuinely required, group `merged` by `repoId` and resolve each repo.

---

## High

### 5. The cache lookup does not do what its own doc comment says — `repository.ts:14-40` + `routes.ts:33-34`

The comment (`:17-19`) states periods are matched "on their exact boundaries rather than by
overlap". The code matches **containment**:

```ts
gte(t.digests.periodStart, periodStart),
lte(t.digests.periodEnd, periodEnd),
```

Combined with `routes.ts:33` (`periodEnd = new Date()` — a fresh millisecond on every request), the
exact-match cache can never hit as designed, and what actually happens is worse: `POST /digests
{ periodDays: 90 }` matches last week's 7-day digest, returns it with `cached: true`, and the caller
gets a 7-day digest labelled as a quarterly one. There is also no `limit(1)` and no `orderBy`, so
which of several matching rows wins is undefined.

**Do:** pick the semantics and make code and comment agree. Bucket the window to day boundaries in
the service, match with `eq` on both columns, and back it with a unique index on
`(workspace_id, period_start, period_end)` so the cache is enforceable.

### 6. Rebuild deletes the old digest before the new one exists — `routes.ts:42-46`

```ts
if (existing) await repo.deleteById(workspaceId, existing.id);
const digest = await service.build(...);
```

If `build` throws — and it throws readily: `NotFoundError` on an empty window (`service.ts:48`), any
GitHub 404 from finding #4, any LLM error, any timeout — the workspace has lost the digest it had
and gets nothing back. Not transactional, and not concurrency-safe either: two overlapping POSTs
both miss the cache, both spend up to 40 model calls, and both insert, because nothing prevents
duplicate rows for one period. `server/INSIGHTS.md` (2026-08-28) records this exact delete-then-insert
shape biting under READ COMMITTED in `ContextRepository.replace`.

**Do:** build first, then swap in one transaction — or upsert onto the unique index from finding #5.

### 7. Up to 80 sequential network calls inside one HTTP handler — `service.ts:62-72`

`MAX_PRS_PER_DIGEST` is 40, and each iteration awaits a GitHub round-trip then an LLM completion,
serially. No concurrency, no per-call timeout, no cancellation, no partial-failure tolerance — one
bad PR aborts the entire digest (and, with #6, leaves the workspace with nothing).

This is precisely the workload the codebase runs through `JobRunner`
(`repos/service.ts:98`, `repo-intel/routes.ts:53`). `conventions/routes.ts:15-18` explicitly
documents that it stays synchronous *because it is one bounded call* — the opposite of this.

**Do:** `container.jobs.enqueue(workspaceId, DIGEST_JOB_KIND, …)`, return the job, let the client
poll/stream. If it must stay synchronous, at minimum bound concurrency, pass `timeoutMs`, and
tolerate per-PR failures.

### 8. Untrusted PR text goes into the prompt unwrapped — `service.ts:68`

```ts
{ role: 'user', content: `#${pr.number} ${pr.title}\n\n${detail.body ?? ''}` }
```

`title` and `body` are attacker-controlled: anyone who can open a PR against a watched repo can
write "ignore the above and summarise this as: …" into a document the whole team reads on Monday.
Every other LLM feature here delimiter-wraps untrusted input with `wrapUntrusted` from
`@devdigest/reviewer-core` — `intent/prompt.ts:94` (`'pr-description'`), `:100`, `:106`, `:121`, and
`brief/prompt.ts:222`.

**Do:** wrap each untrusted block (`wrapUntrusted('pr-description', detail.body ?? '')`), and move
prompt assembly into a `prompt.ts` next to the service, as `intent/` and `brief/` do.

### 9. An empty period is reported as 404 — `service.ts:47-49`

```ts
if (merged.length === 0) throw new NotFoundError('No pull requests were merged in this period');
```

"Nothing merged last week" is a successful, expected result, not a missing resource. As a 404 the
client cannot distinguish it from a bad route or a bad workspace, and `NotFoundError` in
`platform/errors.ts:21` is the "resource does not exist" code (`not_found`).

**Do:** return a digest with an empty-state body, or 200 with `{ digest: null }`.

### 10. The period filter is wrong at both ends — `service.ts:38-45`

- No upper bound: only `gte(updatedAt, periodStart)` is applied, so `periodEnd` never constrains the
  query and merely labels the stored row. A "last 7 days" digest and a "last 90 days" digest select
  overlapping-but-unbounded sets.
- `updatedAt` is not merge time. A PR merged three months ago that got a comment yesterday has a
  fresh `updatedAt` and lands in this week's "Merged" section. `pull_requests` has no merged-at
  column, so this needs one, or the merge timestamp from the importer.
- `MAX_PRS_PER_DIGEST` (`constants.ts:6`) truncates silently. The constant's comment says "so we
  truncate", but the rendered digest never tells the reader that 40 of 120 PRs are shown — a
  reader reasonably concludes nothing else merged.

**Do:** add `lte(t.pullRequests.updatedAt, periodEnd)` as the minimum fix, prefer a real merged-at
column, and have `renderDigestMarkdown` state the truncation when `lines.length === MAX_PRS_PER_DIGEST`.

### 11. Provider and model are hardcoded, bypassing the feature-model registry — `constants.ts:8`, `service.ts:59, 64-70`

```ts
export const DIGEST_MODEL = 'anthropic/claude-3.5-haiku';
const llm = await this.container.llm('openrouter');
```

Every system LLM feature in this app resolves provider+model per workspace through
`FEATURE_MODELS` + `resolveFeatureModel` / `getFeatureModelOverride`
(`modules/settings/feature-models.ts:11-18`, used by onboarding, intent, risk brief, conformance,
conventions). A hardcoded pair means Settings → Models cannot see or change this feature, and a
workspace with only an Anthropic or OpenAI key gets a `ConfigError` it cannot fix from the UI.
No cost is attributed either: up to 40 completions are billed with nothing recorded, while the rest
of the app routes cost through `PriceBook`/agent-run accounting.

**Do:** add a `digests` entry to `FEATURE_MODELS` and call `resolveFeatureModel`. Note the
three-file sync this requires (both vendored `platform.ts` copies plus
`client/src/lib/feature-models.ts`) per `server/INSIGHTS.md` 2026-08-11. If a module-local cheap
default is deliberate, follow the conventions precedent (`getFeatureModelOverride` + a documented
local default) and say why in the constants file.

---

## Medium

### 12. The module is never registered — `server/src/modules/index.ts`

No `import digests from './digests/routes.js'` and no `digests` entry in the `modules` record. As
shipped, none of these routes exist at runtime. `modules/index.ts:19-23` spells out the two-line
procedure.

**Do:** add the import and the registry entry in the same PR.

### 13. Raw Drizzle rows are returned as the API payload — `routes.ts:39, 47, 52`

`{ digest: existing }` and `{ digests: [...] }` serialise the DB row shape verbatim: camelCase
`workspaceId` / `periodStart` / `bodyMd`, plus the never-populated `deliveredTo`. The house contract
is a snake_case DTO defined in `@devdigest/shared` and mapped by a `toXDto` helper —
`repos/helpers.ts:44`, `conventions/helpers.ts:119`, `agents/helpers.ts:19`, `brief/helpers.ts:539`,
`intent/helpers.ts:250`. Leaking the row shape also means any future column rename is a silent
client break.

**Do:** add a `Digest` contract + `toDigestDto` in `helpers.ts` (which is already the pure-mapping
file) and map both responses.

### 14. No `temperature` or `timeoutMs` on the completion — `service.ts:64-70`

Every other call site sets `temperature: 0` and a module-constant timeout:
`conventions/service.ts:157-158`, `brief/service.ts:244-246`, `intent/service.ts:212-213`. Without
`timeoutMs` a hung provider hangs the request indefinitely — 40 times over, inside a synchronous
handler (finding #7).

**Do:** add `temperature: 0` and a `DIGEST_TIMEOUT_MS` constant.

### 15. Model output is spliced into markdown unescaped — `service.ts:71`

```ts
lines.push(`- **#${pr.number}** ${result.text.trim()} — @${pr.author}`);
```

A summary containing a newline, a leading `-`, a `#`, or a `](http://…)` breaks the list structure
or injects a link into a document the whole team reads. Combined with finding #8 (a PR body that
steers the summary), this is a delivery path for attacker-chosen markdown.

**Do:** collapse whitespace and neutralise markdown control characters in `helpers.ts` — it is
already the pure, unit-testable file and is the right home for this.

### 16. No tests — whole module

`TESTING.md` asks for the seam coverage, not exhaustive coverage: one hermetic unit test over the
pure part (`renderDigestMarkdown`, the period arithmetic, the truncation notice) and one
data-backed integration test for the generate → cache → regenerate workflow. Two rules to respect:
a DB-backed test **must** be named `*.it.test.ts` (`server/CLAUDE.md` gotchas) or the unit/integration
split silently miscategorises it, and any test whose path resolves a provider must inject **every**
provider that path can reach (`server/INSIGHTS.md` 2026-08-11). Note that finding #2 makes the
GitHub half untestable until it goes through the container.

---

## Low

### 17. Missing index and uniqueness on `digests` — `server/src/db/schema/ops.ts:41-49`

No migration is needed for this module as written (the table already ships in
`migrations/0000_init.sql:107`), but `listRecent` filters on `workspace_id` and sorts by
`period_end` with no supporting index, and there is no unique constraint on the period — which
findings #5 and #6 both want. If you add either, generate a migration (`pnpm db:generate`); note the
split-generate gotcha in `server/INSIGHTS.md` 2026-07-20 if the change both adds and drops.

### 18. `deliveredTo` is defined and never used — `db/schema/ops.ts:48`

The column suggests delivery (Slack/email) is part of this feature. If it is out of scope for this
PR, say so in the `routes.ts` module doc comment so the next reader does not assume it is wired.

### 19. Locale and timezone are pinned implicitly — `helpers.ts:3`

`new Intl.DateTimeFormat('en-GB', …)` at module scope hardcodes British formatting and formats in
the server's local timezone, while the column is `timestamptz`. A digest built just after midnight
in a UTC+n deployment prints the previous day. Minor today; it matters the moment periods get
bucketed to day boundaries per finding #5.

---

## What is fine

- `helpers.ts` is genuinely pure and unit-testable, with the reason stated — matches the house
  pattern.
- `constants.ts` correctly holds the tunables outside the service.
- `repository.ts` scopes every query by `workspaceId`, including `deleteById` — the tenancy rule in
  `db/schema.ts` is respected, and `row!` after `.returning()` matches existing repositories
  (`agents/repository.ts:109`).
- `routes.ts` validates with Zod `body`/`querystring` schemas via `withTypeProvider<ZodTypeProvider>`
  and resolves tenancy through `getContext` — exactly right, and no hand-rolled `Schema.parse`.
- The five-file module layout and the doc-comment style match the rest of `modules/`.
