# PR Review — `modules/digests`, `modules/memory`, `reviewer-core/review/summarize.ts`

Reviewed against DevDigest's onion/hexagonal conventions (`routes → service → repository`,
ports in `vendor/shared/adapters.ts`, adapters constructed only in `platform/container.ts`,
`reviewer-core` pure behind an injected `LLMProvider`).

**Verdict: request changes.** The `memory` module is close to exemplary. The `digests` module
and `reviewer-core/src/review/summarize.ts` contain several blocking Dependency-Rule
violations — `summarize.ts` in particular breaks all three of `reviewer-core`'s stated
guarantees (no filesystem, no self-constructed provider, mandatory grounding) in one 67-line
file, and additionally does not compile.

---

## Blocking

### 1. `reviewer-core/src/review/summarize.ts:55-66` — findings bypass the mandatory grounding gate

```ts
const result = await llm.completeStructured({ ... schema: SummaryPayload });
return { headline: result.data.headline, findings: result.data.findings, ... };
```

Raw `Finding[]` comes straight off the LLM response and is returned to the caller for display
"above the fold on the PR page" (the file's own doc comment). Grounding is a domain invariant,
not post-processing: `reviewer-core/CLAUDE.md` states "never bypass `groundFindings()`", and
the root `CLAUDE.md` says every finding must cite a real diff line or it is dropped. This is
exactly the "new caller reads `StructuredResult.data.findings` directly and persists them"
failure the gate exists to prevent — it reintroduces hallucinated line citations into the
highest-visibility surface in the product.

**Fix:** pipe the findings through `groundFindings(result.data.findings, input.diff)` and
return only `kept`. If the summariser is meant to re-rank findings the review pass already
grounded, then it should not be asking the model for `findings` at all — take them as input
and have the model return an ordering.

### 2. `reviewer-core/src/review/summarize.ts:5, 39-41` — the core constructs its own provider and reads an API key

```ts
import { OpenRouterProvider } from '../llm/openrouter.js';
...
const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error('OPENROUTER_API_KEY is not configured');
const llm = new OpenRouterProvider(key, { timeoutMs: 60_000 });
```

`reviewer-core/src/index.ts` guarantees "the only side effect is an LLM call through an
INJECTED LLMProvider". `OpenRouterProvider` is allowed to *live* in the package (it is shared
by the CI runner and the studio), but it may only be *constructed* at a consumer's composition
root — `server/src/platform/container.ts`'s `buildLlm()`. Constructing it here means:
- the server path stops going through `SecretsProvider` (`~/.devdigest/secrets.json`) and
  silently switches to `process.env`, which `server/CLAUDE.md` explicitly forbids;
- it loses the `estimateCost`/`PriceBook` wiring `container.buildLlm()` injects, so every
  summarise call is un-costed;
- `ContainerOverrides.llm` no longer reaches it, so this path cannot be mock-tested and any
  test that touches it makes a live network call.

**Fix:** add `llm: LLMProvider` to `SummarizeInput` and delete the import, the env read, and
the construction. The server passes `await container.llm('openrouter')`; the CI runner passes
its own instance.

### 3. `reviewer-core/src/review/summarize.ts:1, 43-46` — filesystem access inside `reviewer-core`

```ts
import { readFile } from 'node:fs/promises';
...
for (const path of input.skillPaths ?? []) skills.push(await readFile(path, 'utf8'));
```

"NO database, GitHub, or filesystem access" is the package's defining constraint. `skillPaths`
also puts an unvalidated absolute path in the hands of the caller with no containment check —
the same reason `SpecDoc.path` is documented as "already containment-checked by the caller
(`safeContextPath` in the server); reviewer-core does no I/O and therefore cannot validate it
itself".

**Fix:** replace `skillPaths?: string[]` with `skills?: string[]` (resolved bodies, matching
`ReviewInput`'s "Resolved skill bodies (NOT slugs)") and let the server read and
containment-check the files before calling.

### 4. `server/src/modules/digests/service.ts:2, 64` — concrete adapter constructed outside the composition root

```ts
import { OctokitGitHubClient } from '../../adapters/github/octokit.js';
...
const github = new OctokitGitHubClient(process.env.GITHUB_TOKEN ?? '');
```

Only `platform/container.ts` imports from `adapters/*`. Two consequences beyond the layering
breach: the token bypasses `SecretsProvider` (and `?? ''` turns a missing token into an opaque
401 rather than the `ConfigError` `container.github()` raises), and `ContainerOverrides.github`
is bypassed — which is why `server/test/digests-service.test.ts:30-34` overrides `llm`,
`embedder` and `git` but has no way to override GitHub, so that test will attempt real network
calls against `api.github.com`.

**Fix:** `const github = await this.container.github();` and delete the import.

### 5. `server/src/modules/digests/service.ts:1, 5, 32-60` — the service queries Drizzle directly

```ts
import * as t from '../../db/schema.js';
...
const merged = await this.container.db.select({ ... }).from(t.pullRequests)...
const [repoRow] = await this.container.db.select({ ... }).from(t.repos)...
```

`reviews/repository.ts` states the invariant: the repository is "the ONLY layer touching the DB"
for its domain. A `service.ts` must never import `db/schema.js` or build a query — especially
when this module already has a `DigestsRepository`. This also puts the module's two most
interesting queries outside anything unit-testable without a live Postgres.

**Fix:** move both queries onto `DigestsRepository` (e.g. `listMergedInPeriod(workspaceId,
periodStart, limit)` and `getRepoRef(repoId)`), or read PR/repo rows through the shared
`container.reviewRepo`, which already owns the pull-request aggregate.

### 6. `server/src/modules/digests/service.ts:6, 83` — reaching into another module's data layer, past its facade

```ts
import { nearest } from '../memory/repository/search.repo.js';
...
const related = await nearest(this.container.db, workspaceId, queryVector, { ... });
```

Two violations at once. (a) `digests` reads `memory`'s persistence directly instead of going
through `MemoryService` — cross-module coupling that `container.agentsRepo` / `container.skillsRepo`
exist specifically to avoid ("consuming modules use `container.agentsRepo` instead of reaching
into another module's folder"). (b) It bypasses the `MemoryRepository` facade and imports the
per-aggregate `search.repo.ts` function — the exact inverse mistake the facade pattern guards
against; the facade's stable public API is pointless if callers reach past it.

Note this also quietly skips `MemoryService.search`'s behaviour: no `dedupeByContent`, no
`markUsed`, and a hand-rolled embed step (line 80-81) duplicating `embedOrNull`.

**Fix:** call `new MemoryService(this.container).search(workspaceId, digestText, { limit:
RELATED_MEMORY_LIMIT })`, or — if this becomes a cross-cutting need — expose `memoryRepo` on
`Container` the way `agentsRepo`/`skillsRepo` are exposed. Either way, `digests` must not import
anything under `memory/repository/`.

### 7. `server/src/modules/digests/routes.ts:6, 28, 36, 42-46, 52` — business logic and repository access in the route

```ts
const repo = new DigestsRepository(app.container.db);
...
const periodStart = new Date(periodEnd.getTime() - req.body.periodDays * 24 * 60 * 60 * 1000);
const existing = await repo.findByPeriod(workspaceId, periodStart, periodEnd);
if (existing && !req.body.regenerate) return { digest: existing, cached: true };
if (existing) await repo.deleteById(workspaceId, existing.id);
const digest = await service.build(...);
```

`routes.ts` is presentation-only: Zod validation → service call → response shaping. Here the
route owns the period-window arithmetic, the cache-hit decision, the regenerate branch, and
three direct repository calls (`findByPeriod`, `deleteById`, `listRecent`). This is the
canonical "bad" example from the routing guide, and it is why the accompanying test has to
drive HTTP with `app.inject` to exercise logic that ought to be callable as
`service.generate(workspaceId, periodDays, regenerate)`.

**Fix:** move the whole `POST` body into a `DigestsService.generate(workspaceId, { periodDays,
regenerate })` returning `{ digest, cached }`, and add `DigestsService.listRecent()` delegating
to the repository. Delete the `DigestsRepository` import and construction from `routes.ts`.

### 8. Neither module is registered — `server/src/modules/index.ts` is untouched

The PR adds `digests/routes.ts` and `memory/routes.ts` but no entry in the static module
registry. `modules/index.ts` documents the requirement: "create `modules/<name>/routes.ts`
exporting a default Fastify plugin, then add one import + one entry below." As it stands neither
plugin is ever mounted, every new endpoint 404s, and `digests-service.test.ts`'s
`expect(res.statusCode).toBe(200)` cannot pass.

**Fix:** add `import digests from './digests/routes.js';` / `import memory from
'./memory/routes.js';` and the two registry entries.

### 9. `server/test/digests-service.test.ts` — DB-backed test with the wrong filename

The file imports `test/helpers/pg.js` and calls `startPg()`, so it must be named
`digests-service.it.test.ts`. `server/CLAUDE.md` is blunt about it: "A DB-backed test **must**
be named `*.it.test.ts` or the unit/integration split silently miscategorizes it." As named, it
lands in the unit lane (`vitest run --exclude '**/*.it.test.ts'`), which is meant to be
hermetic and Docker-free, and is excluded from the integration lane (`vitest run .it.test`) —
so it runs in the wrong lane and never runs in the right one.

**Fix:** rename to `server/test/digests-service.it.test.ts`. (It also isn't a service test — it
drives HTTP; once finding 7 is fixed, most of it should become a direct `DigestsService` call.)

### 10. `reviewer-core/src/review/summarize.ts:48-60` — does not type-check against the real APIs

Three signature mismatches; this file cannot compile:

- `assemblePrompt({ systemPrompt, diff, skills, task })` — `PromptParts` (prompt.ts:200) has
  `system: string`, not `systemPrompt`, and `diff: string`, not `UnifiedDiff`.
- `assemblePrompt` returns `AssembledPrompt` = `{ messages, assembly }` (prompt.ts:247). There
  is no `prompt.system` / `prompt.user`.
- `StructuredRequest` (`vendor/shared/adapters.ts`) requires `messages: ChatMessage[]` and
  `schemaName: string`; it has no `system` or `user` fields.

**Fix:** `const { messages } = assemblePrompt({ system: input.systemPrompt, diff:
renderDiff(input.diff), skills, task: input.task })`, then
`llm.completeStructured({ model, messages, schema: SummaryPayload, schemaName: 'summary' })`.
Please run `npm run typecheck` in `reviewer-core/` before re-requesting review — that package's
typecheck *is* its build.

---

## Should fix before merge

### 11. `server/src/modules/digests/repository.ts:24-40` — `findByPeriod` doesn't do what its doc comment says

The doc comment (lines 17-19) says "Periods are matched on their exact boundaries rather than
by overlap". The query uses `gte(periodStart, periodStart)` and `lte(periodEnd, periodEnd)` —
that's *containment*, so any digest nested inside the requested window matches. A yesterday's
1-day digest will be returned as the cache hit for a fresh 7-day request, and with
`regenerate: true` route line 43 will then delete that unrelated digest. There is also no
`orderBy`/`limit(1)`, so `[row]` picks an arbitrary row when several match.

**Fix:** `eq(t.digests.periodStart, periodStart)` and `eq(t.digests.periodEnd, periodEnd)` to
match the documented intent, plus `.limit(1)`. Note that `periodEnd` is `new Date()` on every
request (routes.ts:33), so exact matching will never hit — the window needs to be normalised
(e.g. truncated to the day) in the service for caching to work at all.

### 12. `server/src/modules/digests/routes.ts:42-46` — destructive rebuild is not atomic

`deleteById` runs before `service.build`. `build` throws `NotFoundError` when the window has no
merged PRs (service.ts:53-54), and can also fail on any GitHub or LLM call in the loop — at
which point the previously cached digest is gone and the caller has nothing. Build first,
insert, then delete the old row (ideally in one transaction), rather than delete-then-rebuild.

### 13. `server/src/modules/digests/service.ts:80-81` — unguarded `container.embedder()`

`Container.embedder()` throws `ConfigError` when `EMBEDDINGS_ENABLED` is false, and its own
comment records the convention: "All callers wrap this in try/catch and degrade gracefully".
`MemoryService.embedOrNull` (memory/service.ts:57-65) does exactly that. Here the whole digest
build fails on a workspace with embeddings off, even though the related-memory lines are
optional garnish. Wrap it, or reuse `MemoryService.search`, which already handles this (see
finding 6).

### 14. `server/src/modules/memory/service.ts:48` vs `repository/item.repo.ts:21` — stated invariant not implemented

`item.repo.ts:21` says "a failed touch must never fail the read", but the caller does
`await this.repo.markUsed(rows.map((r) => r.id));` with no guard, so a failed `UPDATE` rejects
the whole search. Either wrap the call (`.catch(() => {})` / try-catch) or move the guard
inside `markUsed` so the comment is true where it is written.

### 15. `server/src/modules/digests/helpers.ts:1, 13` — pure helper imports another module's row type

```ts
import type { MemoryRow } from '../memory/repository.js';
export function renderMemoryLine(item: MemoryRow): string
```

A "no I/O, unit-testable on its own" helper is coupled to `memory`'s data layer for a function
that only reads `.content`. `memory/helpers.ts:5-7` shows the right shape — a local
`interface HasContent { content: string }`. Do the same here, or move the shared row type to
`db/rows.ts`, which exists precisely so cross-cutting consumers can name a row shape "WITHOUT
importing another module's data layer".

### 16. `server/src/modules/digests/service.ts:57-69` — the digest assumes one repo per workspace

`repoRow` is looked up from `merged[0]!.repoId` and then used as the repo for *every* PR in the
loop. A workspace with more than one imported repo (the normal case) will fetch PR #N from the
wrong repository — returning someone else's PR body, or 404-ing. Group by `repoId`, or resolve
the repo per PR.

### 17. `reviewer-core/src/review/summarize.ts:9-12` — `z.custom<Finding>()` validates nothing

`z.custom<T>()` with no validator accepts any value at runtime, so the structured-output
schema's whole purpose — and `structured.ts`'s parse-with-repair loop — is defeated for the
field that matters most. `@devdigest/shared` exports a real `Finding` Zod schema
(`contracts/findings.ts:47`); use `z.array(Finding)`.

---

## Minor

### 18. `reviewer-core/src/review/summarize.ts` is not exported from `reviewer-core/src/index.ts`

`index.ts` is the package's public surface (it re-exports `review/run.js` and
`review/reduce.js`). Unless a consumer is expected to deep-import — which nothing else does —
`summarizeReview` is unreachable dead code as merged. Add the export, or say in the PR
description which consumer will use it.

### 19. `server/src/modules/digests/service.ts:68-78` — one GitHub call + one LLM call per PR, serially

With `MAX_PRS_PER_DIGEST = 40` that's up to 80 sequential round trips inside an HTTP request,
with no timeout budget and no partial-failure handling (one failed PR fetch kills the whole
digest). Consider bounded concurrency, skipping a PR whose detail fetch fails, and running this
through `container.jobs` rather than inline in the request.

### 20. `DIGEST_MODEL` / `SUMMARY_MODEL` are hardcoded to `anthropic/claude-3.5-haiku`

`digests/constants.ts:8` and `summarize.ts:7` pin the same literal in two packages. Everywhere
else the model comes from agent configuration. At minimum they should not drift independently.

---

## Checked and clean

Worth saying explicitly, since most of the PR is good:

- **`modules/memory/` layering is correct throughout.** `routes.ts` is genuinely
  presentation-only (Zod schema → one service call → response shaping, no branching);
  `service.ts` takes `Container` and holds all the orchestration; `repository.ts` is a facade
  over `repository/{item,search}.repo.ts` with a stable public API — the same shape as
  `reviews/repository.ts`, and the doc comment justifies the split by reason-to-change rather
  than by size. The aggregate files are plain functions taking `Db`, and nothing outside the
  module reaches past the facade (except finding 6, which is `digests`' fault, not `memory`'s).
- `MemoryService.embedOrNull` degrading to `null`/`[]` matches the documented
  "degrade gracefully" convention for optional enrichment.
- `helpers.ts` / `constants.ts` in both modules are pure and I/O-free; splitting tunables out
  so tests can import them is consistent with `settings/helpers.ts`.
- `search.repo.ts:14` interpolates the embedding through Drizzle's `sql` tag, which binds it as
  a parameter — not a string-concatenation injection.
- The type-only cycle between `repository.ts` and `repository/*.repo.ts` is erased at compile
  time and is fine.
- `DigestsService` and `MemoryService` taking the whole `Container`, and row types
  (`DigestRow`, `MemoryRow`) doubling as DTOs, are this repo's documented, intentional
  trade-offs — **not** flagged.
- Neither module needs more layering than it has; `digests` having a `repository.ts` at all is
  proportionate given four distinct queries.
