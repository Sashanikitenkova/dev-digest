# PR review — `digests` + `memory` server modules, `reviewer-core/review/summarize.ts`

Reviewed as if the fixture tree were `server/` and `reviewer-core/`. Findings are ordered
most-important-first. Every "house rule" claim below was verified against the current
repository, not assumed.

**Verdict: request changes.** Four blocking problems (the module registry omission alone
means none of this code is reachable and the PR's own test cannot pass), plus a mandatory
grounding gate that is skipped and a package-purity contract broken three ways.

---

## Critical

### C1. `reviewer-core/src/review/summarize.ts:55-66` — the mandatory grounding gate is skipped

`summarizeReview` takes the model's `findings` straight out of `completeStructured` and
returns them:

```ts
return { headline: result.data.headline, findings: result.data.findings, model: SUMMARY_MODEL };
```

Root `CLAUDE.md`: "Review grounding is mandatory across the pipeline — every finding must
cite a real diff line or it's dropped." `reviewer-core/CLAUDE.md` (Gotchas): "Grounding is
mandatory — never bypass `groundFindings()`." `review/run.ts:216` calls it as "the SHARED
citation-grounding gate (the only post-step; not duplicated per strategy)". This new pass
is a second entry point into the same pipeline and has no gate at all — and per the
docblock its output is what goes "above the fold on the PR page", i.e. the most visible
findings in the product are the only ungrounded ones.

**Do:** run `groundFindings(result.data.findings, input.diff)`, return only `ground.kept`,
and surface `ground.dropped` in the outcome the way `ReviewOutcome.dropped` does, so a drop
is never silent.

### C2. `reviewer-core/src/review/summarize.ts:1, 39-46` — reviewer-core's purity contract is broken three ways

```ts
import { readFile } from 'node:fs/promises';          // line 1  — filesystem I/O
const key = process.env.OPENROUTER_API_KEY;           // line 39 — env/secret read
const llm = new OpenRouterProvider(key, {...});       // line 41 — adapter constructed inside the engine
skills.push(await readFile(path, 'utf8'));            // line 45 — filesystem I/O
```

`reviewer-core/CLAUDE.md` and `src/index.ts:5-6`: "No database, GitHub, or filesystem
access; the only side effect is an LLM call through an INJECTED LLMProvider (so it is
mock-testable)." Today `grep -rn "node:fs\|process\.env\|readFile" reviewer-core/src`
returns **zero** hits — this file would be the first. `ReviewInput` (`review/run.ts:52,57`)
is the pattern: `llm: LLMProvider` injected, `skills?: string[]` already resolved by the
caller ("the caller turns AgentManifest skill slugs into bodies (DB in the studio, fs in
the runner)").

Consequences beyond tidiness: the summariser cannot be unit-tested with a stub provider
(`npm test` is described as "hermetic, stubbed LLMProvider"), it ignores the server's
`SecretsProvider` (`~/.devdigest/secrets.json`, the documented secret source — `.env` is
explicitly *not* it), and it bypasses the `PriceBook` cost attribution the container wires
into the shared OpenRouter provider (`platform/container.ts:193`).

**Do:** change `SummarizeInput` to `{ llm: LLMProvider; model: string; skills?: string[]; … }`,
delete the `readFile` loop and the `process.env` read, and let the caller resolve both.

### C3. `server/src/modules/digests/service.ts:2, 64` — adapter constructed in a module; secret read from `process.env`

```ts
const github = new OctokitGitHubClient(process.env.GITHUB_TOKEN ?? '');
```

Two hard conventions broken at once:

* **Adapters are constructed only in the composition root.** The only
  `new OctokitGitHubClient(...)` in `server/src` is `platform/container.ts:166`; likewise
  every `new SimpleGitClient` / `new OpenAIProvider` / `new AnthropicProvider` /
  `new OpenAIEmbedder`. Modules call `await container.github()` — 8 call sites
  (`modules/pulls/routes.ts:36,230,328,351`, `modules/intent/service.ts:310`,
  `modules/brief/service.ts:631`, `modules/settings/routes.ts:87`,
  `modules/polling/routes.ts:28`).
* **`process.env` never appears under `server/src/modules/`** — `grep -rn "process\.env"
  server/src/modules/` is empty. `server/CLAUDE.md`: "Secrets resolve through
  `SecretsProvider` … not `AppConfig`/`.env`."

The practical damage is worse than the layering: because the client is constructed inside
the service, `ContainerOverrides.github` can never reach it, so the integration test in
this PR issues **live requests to api.github.com** — unauthenticated (empty token → 60
req/hr, private repos 404). This is precisely the failure mode recorded in
`server/INSIGHTS.md` (2026-08-11, "An integration test that injects only SOME providers
silently hits the real network").

**Do:** `const github = await this.container.github();` and delete the `process.env` read.

### C4. Neither module is registered — all of this code is unreachable

`server/src/modules/index.ts` is not touched by the PR. Its docblock is explicit: "ADD A
MODULE: create `modules/<name>/routes.ts` exporting a default Fastify plugin, then add one
import + one entry below," and `app.ts:194` registers only `Object.values(modules)`.

So `POST /digests`, `GET /digests`, `POST /memory`, `GET /memory/search` and
`DELETE /memory/:id` all 404. **The PR's own test cannot pass**:
`server/test/digests-service.test.ts:69` asserts `expect(res.statusCode).toBe(200)` on a
route that is not mounted.

**Do:** add `import digests from './digests/routes.js';` / `import memory from
'./memory/routes.js';` and the two registry entries.

---

## High

### H1. `server/src/modules/digests/routes.ts:28, 33-46` — the route owns the business logic and talks to the repository directly

The handler computes the period, constructs `DigestsRepository` itself, does the cache
lookup, deletes the stale row, and only then calls the service. Two problems:

* **No route in `server/src` constructs a repository** — `grep -rn "new [A-Za-z]*Repository("
  server/src/modules/*/routes.ts` is empty. Repositories are reached through their service
  (`ConventionsService`, `RisksService`, …) or through the container's shared getters.
  `server/CLAUDE.md` Map: `modules/<name>/{routes,service,repository}.ts`.
* **Two live `DigestsRepository` instances** for one request — `routes.ts:28` and
  `service.ts:28` — so the read path and the write path are wired independently and can
  drift.

**Do:** collapse this into one service call, e.g.
`service.generate(workspaceId, req.body.periodDays, req.body.regenerate)` returning
`{ digest, cached }`; the route keeps only `getContext` + schema validation.

### H2. `server/src/modules/digests/routes.ts:42-44` — data loss on a failed regenerate

```ts
if (existing) { await repo.deleteById(workspaceId, existing.id); }
const digest = await service.build(...);
```

The old digest is destroyed *before* the new one is built. `service.build` throws on
several ordinary paths — `NotFoundError` when nothing merged (`service.ts:54`), a GitHub
error, an LLM error, a timeout — and the workspace is then left with no digest at all,
having asked only to refresh one.

**Do:** build first, then replace, and do the delete+insert in a single
`db.transaction` (or make it an upsert on the period key). Note `server/INSIGHTS.md`
(2026-08-28) on delete-then-insert races — take the owner-row lock pattern if you keep two
statements.

### H3. `server/src/modules/digests/repository.ts:24-40` — the cache lookup does not do what its docblock says, and is wrong in both directions

The docblock (lines 14-20) says "Periods are matched on their exact boundaries rather than
by overlap … only an exact re-request counts as a rebuild." The query does the opposite —
`gte(periodStart, periodStart)` + `lte(periodEnd, periodEnd)` is *containment*.

Combined with `routes.ts:33-34`, which recomputes `periodEnd = new Date()` on every
request, the window slides continuously, so:

* **False negative (the common case):** a 7-day digest built five minutes ago has
  `periodStart` five minutes *earlier* than the new one → `gte` fails → the cache never
  hits, and every `POST /digests` pays for up to 40 GitHub + 40 LLM calls. The whole point
  of the module's docblock ("a digest for a period that was already built is reused") never
  fires.
* **False positive:** a `periodDays: 1` digest built five minutes ago *is* contained in the
  7-day window → it is returned as the 7-day digest, `cached: true`.

There is also no `limit(1)` and no ordering, so `const [row] =` picks an arbitrary row when
several match.

**Do:** normalise the period to a stable boundary (UTC day/week) in the service, compare
with `eq` on both columns, and add `.orderBy(desc(...)).limit(1)`.

### H4. `server/src/modules/digests/service.ts:57-69` — every PR is fetched from the *first* PR's repository

```ts
const [repoRow] = await ...where(eq(t.repos.id, merged[0]!.repoId));
...
const detail = await github.getPullRequest({ owner: repoRow.owner, name: repoRow.name }, pr.number);
```

`merged` is workspace-scoped, not repo-scoped, and a workspace holds many repos
(`GET /workspace` lists them; `pull_requests.repo_id` is per-row). Every PR after the first
one from a different repo is looked up as `owner/name#N` under the wrong repository —
either a 404 that aborts the digest, or, when that number exists there too, **a different
PR's body silently summarised into the digest**.

**Do:** join `repos` per PR (or group the PRs by `repoId` and resolve each repo once).

### H5. `server/src/modules/digests/service.ts:32-60` — raw Drizzle inside a service

Two hand-written queries live in the service layer. No `service.ts` anywhere in
`server/src/modules` contains a `.select(` / `.insert(` / `.delete(` against Drizzle —
services hold `this.repo = new XRepository(container.db)` and delegate. These queries also
read `pull_requests` and `repos`, tables owned by other modules, without going through any
repository at all.

**Do:** move both into `DigestsRepository` (e.g. `listMergedInWindow(workspaceId, start,
end)` returning rows already joined to their repo), keeping the service to orchestration.

### H6. `server/src/modules/digests/service.ts:6, 83` — cross-module reach into another module's repository internals

```ts
import { nearest } from '../memory/repository/search.repo.js';
```

This bypasses `MemoryRepository` *and* `MemoryService` and binds `digests` to a private file
inside `memory/repository/`. The only cross-module import in `server/src/modules` today is
a `import type { PrIntentRow }` (`reviews/run-executor.ts:13`) — no module imports another
module's runtime code. `platform/container.ts:71-73` states the rule: "Shared repositories
for cross-cutting entities … constructed here, in the composition root, so consuming modules
use `container.agentsRepo` instead of reaching into another module's folder"
(cf. `skillsRepo`, lines 101-105).

It also loses everything `MemoryService.search` adds — dedupe, `markUsed`, the graceful
no-embedder path — so digests and the memory panel will return different sets for the same
query.

**Do:** add a `memoryRepo` getter to the container (or call `MemoryService`), and import
that.

### H7. `server/test/digests-service.test.ts` — wrong filename for a DB-backed test

`server/CLAUDE.md` Gotchas: "A DB-backed test **must** be named `*.it.test.ts` or the
unit/integration split silently miscategorizes it." The unit lane is
`vitest run --exclude '**/*.it.test.ts'`, so this file — which calls `startPg()` and boots
Postgres in Docker — runs in the *unit* lane. Every other Postgres-backed test in
`server/test/` follows the rule (`brief.it.test.ts`, `reviews.it.test.ts`,
`context.it.test.ts`, …).

**Do:** rename to `server/test/digests.it.test.ts`.

### H8. `server/test/digests-service.test.ts:30-34` — `github` is not injected

```ts
overrides: { llm: {...}, embedder: ..., git: new MockGitClient() },
```

`git` is the simple-git port; the GitHub port is a different one, and `MockGitHubClient`
exists in `src/adapters/mocks.ts` for it. `brief.it.test.ts:9-12` carries the warning in a
header comment ("an un-injected provider silently makes real, billed network calls, and the
tell is runtime (seconds, not a red assertion)"), and `server/INSIGHTS.md` 2026-08-11
records the incident. As written this test reaches the network (via C3, which makes the
override unreachable anyway).

**Do:** add `github: new MockGitHubClient()` *and* fix C3 so the override is honoured.

### H9. `reviewer-core/src/review/summarize.ts:48-60` — the file does not typecheck and could not run

Three signature mismatches against the code it calls:

* `assemblePrompt` takes `PromptParts` (`prompt.ts:199-243`): the field is `system`, not
  `systemPrompt`, and `diff` is a **`string`** (`parts.diff` is passed to
  `wrapUntrusted('diff', parts.diff)`), not a `UnifiedDiff`. Pass `input.diff.raw`, as
  `review/run.ts:161` does.
* `assemblePrompt` returns `AssembledPrompt = { messages, assembly }` (`prompt.ts:246-249`).
  `prompt.system` and `prompt.user` do not exist — both would be `undefined`.
* `StructuredRequest` (`vendor/shared/adapters.ts:55-70`) is `{ model, schema, schemaName,
  messages, … }`. There is no `system`/`user` pair and `schemaName` is required;
  `OpenRouterProvider.completeStructured` does `const messages = [...req.messages]`
  (`llm/openrouter.ts:63`), which throws on `undefined`.

`npm run typecheck` **is** the build for this package (`reviewer-core/CLAUDE.md`), so this
is a red build, not a nit.

### H10. `reviewer-core/src/review/summarize.ts:9-12` — `z.custom<Finding>()` validates nothing

```ts
findings: z.array(z.custom<Finding>()),
```

`z.custom` with no validator accepts *any* value, including `{}` or `null`. `@devdigest/shared`
exports a real Zod `Finding` schema (`contracts/findings.ts:47`), which `Review` itself
composes (`findings: z.array(Finding)`, line 85) and `review/run.ts:195` uses via
`ReviewSchema`. It also defeats the provider's parse-with-repair retry loop, which only
retries when the schema *rejects* the output. Combined with C1 (no grounding), arbitrary
model JSON is typed as `Finding[]` and rendered.

**Do:** `findings: z.array(Finding)` — and pass a real `schemaName`.

---

## Medium

### M1. `server/src/modules/digests/service.ts:44-51` — the window has no upper bound, and `updatedAt` is not a merge time

`gte(t.pullRequests.updatedAt, periodStart)` with no `lte(..., periodEnd)`: regenerating an
older period silently pulls in everything merged since. Also `pull_requests.updatedAt` is
**nullable** (`db/schema/pulls.ts:28`), so PRs with a null `updatedAt` are dropped from
every digest, and it is a last-touched timestamp — a comment edit after merge moves a PR
into a later digest. Add the upper bound; if a true merge timestamp is needed, add a column
rather than overloading this one.

### M2. `server/src/modules/digests/service.ts:67-78` — up to 80 sequential network round-trips inside an HTTP handler

`MAX_PRS_PER_DIGEST = 40`, and each iteration awaits a GitHub call *then* an LLM call, with
no concurrency, no timeout, no cancellation check and no per-PR error handling — one 404
aborts the whole digest after the old one was already deleted (H2). A 40-PR digest holds
the request open for minutes. Long work in this codebase goes through `JobRunner`
(`platform/jobs.ts`); the synchronous exception is documented in `conventions/routes.ts:16-19`
precisely because it is *one* cheap call over a bounded sample. Either move this to a job
with SSE progress (`container.runBus`), or bound it hard and catch per PR.

### M3. `server/src/modules/digests/constants.ts:8` + `service.ts:65` — model and provider are hardcoded

`DIGEST_MODEL` and `container.llm('openrouter')` bypass the per-feature model settings.
`modules/settings/feature-models.ts` exists so "System LLM features … read their
provider/model from the workspace's Settings instead of a hardcoded module constant", with
`getFeatureModelOverride` / `resolveFeatureModel`; `conventions/service.ts:149` is the
worked example and `conventions/constants.ts:23` explains why. Register a `digests` feature
id and resolve through it.

### M4. `server/src/modules/digests/service.ts:53-55` — "nothing merged" is not a 404

`throw new NotFoundError('No pull requests were merged in this period')` turns a quiet week
into an error toast, and (with H2) into data loss. An empty period should produce an empty
digest, or a `204`/explicit `{ digest: null }`.

### M5. `server/src/modules/memory/service.ts:48` — the "must never fail the read" touch can fail the read

`item.repo.ts:21` documents the intent: "Recency feeds ranking later; a failed touch must
never fail the read." But the service awaits it unguarded:

```ts
await this.repo.markUsed(rows.map((r) => r.id));
```

A dead connection or a lock timeout on the `UPDATE` turns a successful search into a 500.
Wrap in `try/catch` (the same defensive shape `embedOrNull` already uses two methods down).

### M6. `server/src/modules/memory/service.ts:43-49` — the limit is applied before dedupe

The DB `limit` caps the rows, then `dedupeByContent` removes some, so a caller asking for
8 items can receive 2 — while more distinct matches sit just past the cut. Over-fetch (e.g.
`limit * 2`), dedupe, then `slice(0, limit)`.

### M7. `server/src/modules/memory/` — `repository.ts` **and** `repository/` is a layout deviation, and the two form an import cycle

`server/CLAUDE.md` Map documents `modules/<name>/{routes,service,repository}.ts`; no
existing module splits its repository into a sibling directory (`repo-intel` uses
`pipeline/`, which is orchestration, not data access). Practically, publishing
`repository/search.repo.ts` as an importable entry point is what made H6 easy.

There is also a cycle: `repository.ts` imports `./repository/item.repo.js` and
`./repository/search.repo.js`, and both import `../repository.js`. It is `import type`
today so it erases at compile time and is harmless — but it becomes a real runtime cycle
the moment anyone imports a *value* across that boundary. Move the shared
`InsertMemory` / `NearestOptions` / `MemoryRow` types into a `types.ts` (or a single
`repository.ts`) so the direction is one-way.

### M8. `server/src/modules/memory/routes.ts:9-14` — `scope: 'repo'` does not require `repoId`

The body schema allows `{ scope: 'repo' }` with no `repoId`. Such a row can never be
retrieved by the repo-scoped branch of `nearest` (`search.repo.ts:23`) and is
indistinguishable from a global item. Use `.refine()` or a discriminated union so the
invalid combination is a 422 at the edge.

### M9. `server/src/modules/memory/repository/search.repo.ts:19-25` — search ignores `scope`

`nearest` filters on `workspaceId` and optionally `repoId`, never on `scope`, so a
`repo`-scoped memory from repo A is a candidate answer for a global query about repo B.
Given `scope` is a required column with three values, either filter on it or document why
it is retrieval-irrelevant.

### M10. `reviewer-core/src/review/summarize.ts:19-20, 44-46` — unvalidated absolute paths, and skill bodies land in the trusted slot

Two issues in the loop that C2 removes; both matter if any version of this survives:

* `skillPaths` are absolute paths read with no containment check. The server has
  `safeContextPath` for exactly this reason, and `prompt.ts:96-98` notes that a
  repo-relative path is "already containment-checked by the caller (`safeContextPath` in
  the server); reviewer-core does no I/O and therefore cannot validate it itself."
* The bodies go straight into `assemblePrompt`'s `skills` slot, which renders them
  **unwrapped** (`prompt.ts:262-263`). `formatSkillBlocks` (`prompt.ts:78-84`) exists
  because only `source: 'manual'` skills are trusted — "Imported / community / extracted
  bodies are someone else's instructions landing inside the agent's prompt — they are DATA,
  never instructions." Bypassing it is a prompt-injection hole, and the docblock there warns
  that "duplicating it on one side is how the two silently diverge."

**Do:** accept `SkillBlock[]` (or already-formatted strings) from the caller and let
`formatSkillBlocks` decide the trust wrapping.

### M11. `reviewer-core/src/review/summarize.ts` is not exported from `src/index.ts`

`index.ts` deliberately enumerates the package's public surface (`reviewPullRequest`,
`groundFindings`, …). A deep import via the `@devdigest/reviewer-core/*` alias
(`server/tsconfig.json:25`) would work, but every existing consumer goes through the root
entry. Add the export (with its `SummarizeInput` / `SummarizeOutcome` types) so the surface
stays discoverable and the alias stays a single door.

---

## Low / nits

* **`server/test/digests-service.test.ts:9-13` — the docblock promises a test that isn't
  there.** "a second request for the same window reuses the stored row rather than
  rebuilding" is never asserted; there is only one `app.inject`. That is exactly the path
  H3 breaks. Add the second request and assert `cached: true` — it will fail today, which
  is the point.
* **`digests/routes.ts:30-48` — a creating POST returns 200.** `memory/routes.ts:39` sets
  `201` for the analogous create. Be consistent.
* **Neither module declares response schemas.** Requests are validated (correctly, via the
  Zod type provider) but responses are not serialized through a schema, so a shape change
  leaks silently. `app.ts:136` has a handler for `isResponseSerializationError` that these
  routes can never trigger.
* **No uniqueness on a digest period.** `db/schema/ops.ts:41-50` has no unique index on
  `(workspace_id, period_start, period_end)`, and the route's check-then-insert is not
  atomic, so two concurrent `POST /digests` both miss the cache and insert — while the test
  asserts `rows).toHaveLength(1)`. Add the constraint (plus a migration) and let the insert
  be an upsert.
* **`db/schema/ops.ts:47-49` — `period_start`, `period_end` and `body_md` are nullable**
  while the module treats all three as required, so `DigestRow.bodyMd` is `string | null`
  for every consumer. Tighten to `.notNull()` in a migration if digests are going live.
* **`db/schema/knowledge.ts:28` — no ANN index on `memory.embedding`.** Only
  `memory_ws_idx` exists, so every `nearest` is a sequential scan plus a full sort over the
  workspace's memories. Fine at seed scale, worth an `hnsw`/`ivfflat` index before it is
  not.
* **`digests/service.ts:57-60` — the repo lookup is not workspace-scoped.** It filters on
  `t.repos.id` alone. Safe today because `repoId` came from a workspace-scoped row, but
  every other cross-table read in this codebase carries the `workspaceId` predicate; keep
  the habit.
* **`digests/repository.ts:56-60` — `deleteById` returns `void`.** It cannot distinguish
  "deleted" from "not found"; `memory`'s `deleteItem` returns a boolean via
  `.returning()` and the service turns that into a 404. Mirror it.

---

## What I checked and found clean

* `memory/helpers.ts` — pure, no I/O, correctly unit-testable as claimed; the module-level
  `/\s+/g` regex is safe with `String.replace` (which resets `lastIndex`).
* `memory/repository/search.repo.ts:14` — the embedding is interpolated through Drizzle's
  `sql` template, so it is a bound parameter, not string concatenation. No injection.
* Both route files use `getContext(app.container, req)` and thread `workspaceId` into every
  query — workspace scoping is not forgotten (the one exception noted above).
* Both route files validate with Zod `schema.body` / `schema.params` / `schema.querystring`
  via `withTypeProvider<ZodTypeProvider>()`, and reuse `IdParams` from `_shared/schemas.ts`
  — the documented pattern, not a hand-rolled `Schema.parse(req.body)`.
* `MemoryService.embedOrNull` correctly degrades when embeddings are disabled, matching the
  container's contract at `platform/container.ts:203-211` ("All callers wrap this in
  try/catch and degrade gracefully").
* `memory/service.ts` and `memory/repository.ts` follow the house layering: service holds a
  repository built from `container.db`, repository owns all Drizzle.
* No migration is needed for either table — `digests` and `memory` already exist in
  `db/schema/{ops,knowledge}.ts` (the "every future-lesson table already exists" note in
  `server/CLAUDE.md`), so the PR is right not to add one. The tightening in the Low section
  would need one.
