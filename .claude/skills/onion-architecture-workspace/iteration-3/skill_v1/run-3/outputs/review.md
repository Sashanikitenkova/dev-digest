# PR Review — `digests` + `memory` modules, `reviewer-core/review/summarize.ts`

Reviewed against the `onion-architecture` skill (Dependency Rule, routes-are-presentation-only,
repository-owns-the-DB, composition-root discipline, `reviewer-core` purity + the mandatory
grounding gate), plus `server/CLAUDE.md` and `reviewer-core/CLAUDE.md`.

**Verdict: request changes.** The `memory` module is close to exemplary. The `digests` module and
`reviewer-core/src/review/summarize.ts` contain several blocking layering violations — including two
that break documented, non-negotiable invariants of this codebase (the grounding gate and
`reviewer-core`'s zero-I/O guarantee).

---

## Blocking (must fix before merge)

### 1. `summarize.ts` bypasses the mandatory grounding gate
`reviewer-core/src/review/summarize.ts:55-66`

```ts
const result = await llm.completeStructured({ ... });
return { headline: result.data.headline, findings: result.data.findings, model: SUMMARY_MODEL };
```

Raw model `findings` are returned straight to the caller with no citation check. `reviewer-core/CLAUDE.md`
states this plainly: *"Grounding is mandatory — never bypass `groundFindings()` or trust the model's
self-reported score."* `grounding.ts` exists specifically to drop findings whose `[start_line, end_line]`
does not intersect a real hunk. This new path re-introduces exactly the hallucinated line citations the
invariant prevents, and anything that persists these findings will write unverifiable locations to the DB.

**Fix:** pipe the result through `groundFindings(result.data.findings, input.diff)` before returning, and
return the surviving findings (plus a grounding summary if the caller needs it), the way `review/run.ts:216`
does. If the summariser is genuinely meant to re-surface findings the review pass already grounded, then it
should not be re-deriving findings from the model at all — it should take already-grounded `Finding[]` as
input and only produce the headline.

### 2. `summarize.ts` constructs its own LLM provider and reads an API key
`reviewer-core/src/review/summarize.ts:5, 39-41`

```ts
import { OpenRouterProvider } from '../llm/openrouter.js';
...
const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error('OPENROUTER_API_KEY is not configured');
const llm = new OpenRouterProvider(key, { timeoutMs: 60_000 });
```

`reviewer-core/src/index.ts` guarantees *"the only side effect is an LLM call through an INJECTED
LLMProvider (so it is mock-testable)."* `OpenRouterProvider` is allowed to *live* in the package, but is
only ever constructed at a consumer's composition root (`server/src/platform/container.ts`'s `buildLlm()`,
or the CI runner). Constructing it here hard-wires one provider into the engine, bypasses the server's
`SecretsProvider` (secrets live in `~/.devdigest/secrets.json`, not `process.env` — see `server/CLAUDE.md`),
bypasses `ContainerOverrides.llm`, and makes the function untestable without a live network key.

**Fix:** add `llm: LLMProvider` (and ideally `model: string`) to `SummarizeInput` and use the injected value.
Delete the `OpenRouterProvider` import and the `process.env` read.

### 3. `summarize.ts` reads the filesystem
`reviewer-core/src/review/summarize.ts:1, 19, 44-46`

```ts
import { readFile } from 'node:fs/promises';
...
for (const path of input.skillPaths ?? []) skills.push(await readFile(path, 'utf8'));
```

`reviewer-core` has **no** filesystem access by design ("NO database, GitHub, or filesystem access").
`ReviewInput` documents the convention for exactly this case: *"Resolved skill bodies (NOT slugs)."*
Beyond the layering break, this also makes the CI-runner path read paths that only exist on the studio host,
and turns an arbitrary caller-supplied path into an unbounded file read inside the engine.

**Fix:** replace `skillPaths?: string[]` with `skills?: string[]` (already-resolved bodies) and let the
caller in `server/` do the reading.

### 4. `DigestsService` imports and constructs a concrete adapter
`server/src/modules/digests/service.ts:2, 64`

```ts
import { OctokitGitHubClient } from '../../adapters/github/octokit.js';
...
const github = new OctokitGitHubClient(process.env.GITHUB_TOKEN ?? '');
```

Only `platform/container.ts` may import from `adapters/*`. `Container.github()` already exists
(`container.ts:161-167`) and resolves `GITHUB_TOKEN` through `SecretsProvider`, throwing a clean
`ConfigError` when it is missing — this version silently passes `''` and fails later as a 401.
It also bypasses `ContainerOverrides.github`, which is why `server/test/digests-service.test.ts:30-34`
overrides `llm`/`embedder`/`git` but has no way to stub GitHub — that test will attempt real network calls.

**Fix:** `const github = await this.container.github();` and drop the import and the `process.env` read.

### 5. `DigestsService` queries Drizzle directly instead of going through its repository
`server/src/modules/digests/service.ts:1, 5, 32-51, 57-60`

```ts
import * as t from '../../db/schema.js';
...
const merged = await this.container.db.select({...}).from(t.pullRequests)...
const [repoRow] = await this.container.db.select({...}).from(t.repos)...
```

The repository is the only layer that touches the DB for its domain (`reviews/repository.ts`'s own doc
comment: *"The ONLY layer touching the DB for the review domain"*). A service must never import
`db/schema.js`. Note `DigestsRepository` already exists in this same PR — the queries just were not put there.

**Fix:** add `listMergedPulls(workspaceId, periodStart, limit)` and `getRepo(repoId)` to
`DigestsRepository` (or read pulls through the existing pulls-domain repository, since `pull_requests`
and `repos` are not the digests domain's tables) and call those from the service.

### 6. `digests/routes.ts` is not presentation-only — it holds the caching business logic and talks to the repository
`server/src/modules/digests/routes.ts:6, 28, 36-47, 52`

```ts
const repo = new DigestsRepository(app.container.db);
...
const existing = await repo.findByPeriod(workspaceId, periodStart, periodEnd);
if (existing && !req.body.regenerate) return { digest: existing, cached: true };
if (existing) await repo.deleteById(workspaceId, existing.id);
const digest = await service.build(...);
```

A `routes.ts` validates, calls the service, and shapes the response — no direct repository calls and no
branching on domain state. The reuse-vs-rebuild rule is the *core* business rule of this module (it is what
stops the same period being billed twice, per the file's own doc comment) and it is sitting in the HTTP layer,
where it can only be tested by booting Fastify. The `GET` handler at line 52 has the same problem.

**Fix:** move period computation, the cache lookup, the rebuild branch and the delete into
`DigestsService.generate(workspaceId, { periodDays, regenerate })` returning `{ digest, cached }`, and add
`DigestsService.list(workspaceId, limit)`. Delete the `DigestsRepository` import and construction from `routes.ts`.

### 7. `DigestsService` reaches into another module's per-aggregate repository file
`server/src/modules/digests/service.ts:6, 83`

```ts
import { nearest } from '../memory/repository/search.repo.js';
...
const related = await nearest(this.container.db, workspaceId, queryVector, { limit: RELATED_MEMORY_LIMIT });
```

Two violations at once: (a) one module reaching into another module's data-access layer, and (b) reaching
*past* the `MemoryRepository` facade into `repository/<aggregate>.repo.ts` — the guide calls this out
explicitly as "the inverse mistake … which defeats the point of having a stable composed API." The
`memory` module's facade was written correctly in this same PR and is then bypassed by its sibling.

**Fix:** call `MemoryService.search(...)` (which also applies `dedupeByContent` and `markUsed`, both silently
skipped here), or, if raw vector access is really needed, expose a method on `MemoryRepository` and consume
the facade class. Do not import `repository/search.repo.js` from outside the memory module.

### 8. A DB-backed test is named `*.test.ts`
`server/test/digests-service.test.ts:1-3, 15, 25-27`

It calls `startPg()` / `dockerAvailable()` and boots the real app against Postgres, but is named
`digests-service.test.ts`. `server/CLAUDE.md` is explicit: *"A DB-backed test **must** be named
`*.it.test.ts` or the unit/integration split silently miscategorizes it"* — and `pnpm exec vitest run
--exclude '**/*.it.test.ts'` is the unit lane, so as named this file will run (and try to start Docker)
in the unit job. Every other DB test in `server/test/` follows the convention (`reviews.it.test.ts`,
`brief.it.test.ts`, …).

**Fix:** rename to `server/test/digests.it.test.ts`. Separately, the module's real business rule (cached
reuse on the second request) is never exercised — the test only asserts `cached === false`.

### 9. `summarize.ts` does not compile against the APIs it calls
`reviewer-core/src/review/summarize.ts:48-60`

Three mismatches:
- `assemblePrompt` takes `PromptParts` with `system: string` and `diff: string` (`prompt.ts:200-245`),
  not `systemPrompt` and a `UnifiedDiff` object.
- It returns `AssembledPrompt = { messages, assembly }` (`prompt.ts:247-250`) — there is no
  `prompt.system` / `prompt.user`.
- `StructuredRequest` (`vendor/shared/adapters.ts:55-69`) requires `model`, `schema`, `schemaName` and
  `messages` — `system`/`user` are not fields and `schemaName` is missing.

**Fix:** pass `{ system, diff, skills, task }` and forward `prompt.messages` with a `schemaName`. This
file appears not to have been typechecked (`npm run typecheck` in `reviewer-core/` is the build).

---

## Should fix

### 10. All PRs in a digest are fetched against the *first* PR's repository
`server/src/modules/digests/service.ts:57-69`

`repoRow` is resolved once from `merged[0]!.repoId`, then every `github.getPullRequest(...)` in the loop uses
that owner/name. A workspace with more than one imported repo will fetch the wrong PR body, or 404. Resolve
the repo per PR (batch the lookup by `repoId`) rather than assuming a single-repo workspace.

### 11. Rebuild deletes the old digest *before* building the new one
`server/src/modules/digests/routes.ts:42-44`

`deleteById` runs before `service.build()`. `build()` can throw (`NotFoundError`, GitHub failure, LLM
failure) — leaving the workspace with neither the old nor a new digest. Build first, then replace inside a
transaction (or upsert), in the service.

### 12. `findByPeriod` contradicts its own doc comment and never matches
`server/src/modules/digests/repository.ts:14-40`

The doc says *"Periods are matched on their exact boundaries rather than by overlap"*, but the query uses
`gte(periodStart, ...)` / `lte(periodEnd, ...)`, i.e. containment. Combined with `routes.ts:33-34`, where
`periodEnd = new Date()` on every request, a previously stored digest's `periodStart` is always *earlier*
than the new `periodStart`, so `gte` never holds — the cache never hits, every POST re-bills the whole model
loop, and duplicate rows accumulate. Either compare exact boundaries (`eq` on both) after snapping the window
to a stable boundary (e.g. midnight UTC), or match by `periodDays` + a normalized period key.

### 13. `digests/helpers.ts` imports a row type from another module's data layer
`server/src/modules/digests/helpers.ts:1`

```ts
import type { MemoryRow } from '../memory/repository.js';
```

`server/src/db/rows.ts` exists precisely so cross-cutting consumers can reference a row shape *"WITHOUT
importing another module's data layer."* Add `MemoryRow` to `db/rows.ts`, re-export it from
`memory/repository.ts`, and import it from `db/rows.js` here. Better still, have `renderMemoryLine` accept
a structural `{ content: string }` — it only reads `content`.

### 14. `z.custom<Finding>()` turns off validation on the model's output
`reviewer-core/src/review/summarize.ts:9-12`

`z.custom` with no validator accepts anything at runtime, so `completeStructured`'s parse-with-repair loop
cannot reject a malformed finding, and the generated JSON schema for the model is uninformative. Use the real
`Finding` schema exported from `@devdigest/shared` (`contracts/findings.ts:47`).

### 15. Module registration and public export are missing from the PR
`server/src/modules/index.ts`, `reviewer-core/src/index.ts` (unchanged)

Neither `digests` nor `memory` appears in the static module registry, yet `digests-service.test.ts:63-69`
injects `POST /digests` and expects 200 — that test cannot pass as submitted. Likewise `summarizeReview` is a
new public entry point that is not exported from `reviewer-core/src/index.ts`. Add one import + one entry per
module in `modules/index.ts`, and the export in the engine's index.

---

## Minor / nits

16. **No rate limit on `POST /digests`** (`digests/routes.ts:30`). Every other LLM-spending route in this
    repo caps itself (`reviews/routes.ts:29`, `brief/routes.ts:52`, `intent/routes.ts:43`:
    `config: { rateLimit: { max: 10, timeWindow: '1 minute' } }`). This endpoint can trigger up to 40 model
    calls per request — it is the most expensive unguarded route in the server.
17. **Sequential N+1 over up to 40 PRs** (`digests/service.ts:68-78`): a GitHub round-trip *and* an LLM call
    per PR, serially. Batch the GitHub reads and bound the LLM concurrency, or the request will time out long
    before `MAX_PRS_PER_DIGEST`.
18. **`NotFoundError` for an empty period** (`digests/service.ts:53-54`): "nothing merged this week" is a
    valid, successful outcome, not a 404. Return an empty digest instead.
19. **`markUsed` runs before dedupe** (`memory/service.ts:48-49`): recency is touched on rows that are then
    discarded as duplicates, biasing the ranking signal it feeds. Dedupe first, then mark.
20. **Bare `catch {}` in `embedOrNull`** (`memory/service.ts:57-65`): the degrade-gracefully behaviour is
    documented and reasonable, but this also swallows genuine bugs with no log line, and an item stored with a
    null embedding is invisible to search forever with no re-embed path. At minimum log at `warn`.
21. **`repoId` is not checked against the workspace** (`memory/routes.ts:13`, `memory/service.ts:36`): the body
    accepts any UUID and it is stored unvalidated. Also, `scope: 'repo'` with no `repoId` is accepted — worth a
    Zod `superRefine`.
22. **No tests for the `memory` module** at all, and none for `dedupeByContent` / `renderDigestMarkdown`
    despite both helper files advertising themselves as *"unit-testable on its own"*.

---

## What is good (checked and clean)

- **`memory/repository.ts` + `repository/{item,search}.repo.ts`** is a textbook facade-over-aggregate split:
  plain exported functions per aggregate, one composing class with a stable public API, doc comment explaining
  the split. This matches `reviews/repository.ts` exactly.
- **`memory/routes.ts`** is correctly presentation-only: Zod schemas via the type provider, `getContext` for
  workspace scoping, one service call per handler, no repository or adapter reach-through.
- **`memory/service.ts`** depends on `Container` and reaches the embedder through `container.embedder()` —
  the port, not the concrete `OpenAIEmbedder`. The whole-`Container` constructor is this repo's documented,
  intentional trade-off and is *not* a finding.
- **Both `constants.ts` and `helpers.ts` files** are pure, I/O-free, and correctly separated.
- **`digests/repository.ts`** itself is well-formed (scoped by `workspaceId` on every query, `Db` injected,
  row type inferred) apart from the `findByPeriod` predicate noted above.
- No `db/rows.ts`-style parallel domain-entity layer was introduced, and no unnecessary ports were added for
  the small `memory` domain — the layering depth is proportionate.
