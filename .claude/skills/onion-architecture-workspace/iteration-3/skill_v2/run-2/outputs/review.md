# PR review — `modules/digests`, `modules/memory`, `reviewer-core/review/summarize.ts`

Reviewed against `.claude/skills/onion-architecture` (SKILL.md + all five guides), the
real `server/src/platform/container.ts`, `server/src/vendor/shared/adapters.ts`,
`server/src/db/rows.ts`, `server/src/modules/index.ts`, `reviewer-core/src/*` and
`TESTING.md`.

**Verdict: request changes.** Seven blocking layering violations, plus a set of
type/API mismatches in `summarize.ts` that cannot compile as written, plus two
correctness bugs that make the digest cache and the GitHub enrichment path
non-functional.

Paths below are relative to the repo root as the PR proposes them
(`server/…`, `reviewer-core/…`).

---

## Blocking — Dependency Rule violations

### 1. `reviewer-core/src/review/summarize.ts:5, 39–41` — the core constructs its own LLM provider and reads an API key

```ts
const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error('OPENROUTER_API_KEY is not configured');
const llm = new OpenRouterProvider(key, { timeoutMs: 60_000 });
```

This is the exact violation `reviewer-core/src/index.ts` guards against: *"the only
side effect is an LLM call through an INJECTED LLMProvider"*. `guides/reviewer-core-llm-port.md`
names it explicitly as the "bad" case — `OpenRouterProvider` may *live* in the package,
but it is constructed **only at a consumer's composition root** (`container.ts`'s
`buildLlm()`, or the CI runner). Constructing it here also hard-bypasses
`SecretsProvider`: the studio keeps keys in `~/.devdigest/secrets.json`, not
`process.env`, so this path would fail in the studio while silently working in CI, and
it drops the `estimateCost` injection that `buildLlm()` supplies, so every summarise
call loses cost attribution.

**Fix:** add `llm: LLMProvider` to `SummarizeInput` and take it as a parameter, exactly
as `ReviewInput.llm` does in `review/run.ts`. Delete the `OpenRouterProvider` import,
the `process.env` read and the local construction. The server resolves the provider via
`await container.llm('openrouter')` and passes it in.

### 2. `reviewer-core/src/review/summarize.ts:1, 43–46` — filesystem access inside `reviewer-core`

```ts
import { readFile } from 'node:fs/promises';
…
for (const path of input.skillPaths ?? []) {
  skills.push(await readFile(path, 'utf8'));
}
```

`reviewer-core` is declared "NO database, GitHub, or filesystem access". `ReviewInput`
already documents the correct contract — *"Resolved skill bodies (NOT slugs)"* — and
the SKILL.md quick reference says it directly: resolve it to a plain string in the
caller and pass it in as data. As written, this also makes the whole function
untestable without a real filesystem, and it takes an absolute path from the caller
straight into `readFile` with no containment.

**Fix:** replace `skillPaths?: string[]` with `skills?: string[]` (already-resolved
bodies). The studio resolves them from the DB via `container.skillsRepo`; the CI runner
reads them from disk. Drop the `node:fs/promises` import.

### 3. `reviewer-core/src/review/summarize.ts:55–66` — findings returned without `groundFindings()`

```ts
const result = await llm.completeStructured({ … });
return { headline: result.data.headline, findings: result.data.findings, … };
```

`result.data.findings` goes straight to the caller. This is the mandatory grounding
gate being bypassed — `reviewer-core/CLAUDE.md`: *"Grounding is mandatory — never
bypass `groundFindings()`"*; the root `CLAUDE.md`: *"every finding must cite a real
diff line or it's dropped"*; and `guides/reviewer-core-llm-port.md` uses precisely this
shape ("reading `StructuredResult.data.findings` directly … and persisting them") as
its bad example. Since these findings are what gets surfaced "above the fold on the PR
page", hallucinated line citations land in the most prominent slot in the product.

**Fix:** pipe through `groundFindings(result.data.findings, input.diff)` and return
`kept`; surface the dropped ones the way `review/run.ts` does (`groundingSummary`).
Note this only works once `diff` stays a real `UnifiedDiff` — see finding 11.

### 4. `server/src/modules/digests/service.ts:2, 64` — service imports and constructs a concrete adapter

```ts
import { OctokitGitHubClient } from '../../adapters/github/octokit.js';
…
const github = new OctokitGitHubClient(process.env.GITHUB_TOKEN ?? '');
```

`platform/container.ts` is the only file allowed to import `adapters/*`
(`guides/layer-model.md`: *"If you find yourself importing from `server/src/adapters/*`
anywhere outside `container.ts`, that's a Dependency Rule violation"*). It also
duplicates secret handling: `container.github()` resolves `GITHUB_TOKEN` through
`SecretsProvider` and throws a typed `ConfigError` when absent, whereas this falls back
to `''` and will fail later as an opaque 401. And it bypasses `ContainerOverrides.github`
entirely — which is why the accompanying test (which injects `llm`, `embedder` and
`git`, but has no way to inject `github`) would attempt real network calls to
api.github.com.

**Fix:** `const github = await this.container.github();`. Delete the import.

### 5. `server/src/modules/digests/service.ts:1, 5, 32–60` — Drizzle queries inside the service

The service imports `drizzle-orm` and `db/schema.js` and runs two inline
`this.container.db.select()` queries (merged PRs, then the repo row) while a
`DigestsRepository` already exists two lines above. This breaks the "repository is the
ONLY layer touching the DB for its domain" invariant
(`guides/drizzle-repository-pattern.md`, bad example #1 is this exact shape). Worse,
both queries read tables the digests module does not own — `pull_requests` and `repos`
belong to `modules/pulls` / `modules/repos`.

**Fix:** move the persistence out of the service. For the digests-owned part, add
methods to `DigestsRepository`. For the merged-PR list and the repo lookup, call the
owning module's service or a `container.*Repo` getter rather than querying another
domain's tables from here (`guides/drizzle-repository-pattern.md`, "Across modules");
take `PullRow` from `db/rows.ts` if a row type is needed. `service.ts` must not import
`db/schema.js` at all.

### 6. `server/src/modules/digests/service.ts:6, 83` — reaching into another module's aggregate repo file

```ts
import { nearest } from '../memory/repository/search.repo.js';
…
const related = await nearest(this.container.db, workspaceId, queryVector, { … });
```

This is the strongest form of the cross-module rule in the skill: not merely another
module's `repository.ts`, but *past its facade* into `repository/<aggregate>.repo.ts`.
`guides/drizzle-repository-pattern.md` records that the tree currently has **zero**
cross-module imports of an aggregate `.repo.ts`; this would be the first. It also
defeats `MemoryRepository`'s stable public API and skips everything `MemoryService.search`
adds (`markUsed`, `dedupeByContent`, the embed-or-degrade path).

**Fix:** construct/inject `MemoryService` and call
`memoryService.search(workspaceId, text, { limit: RELATED_MEMORY_LIMIT })` — modules
composing each other's *services* is normal here. That also removes the need for the
digests service to own the embedder call (finding 12). Alternatively, expose a
`container.memoryRepo` getter alongside `agentsRepo`/`reviewRepo`/`skillsRepo` if raw
repository access is genuinely wanted.

### 7. `server/src/modules/digests/routes.ts:6, 28, 36–52` — route owns a repository and the business rules

```ts
const repo = new DigestsRepository(app.container.db);
…
const existing = await repo.findByPeriod(workspaceId, periodStart, periodEnd);
if (existing && !req.body.regenerate) return { digest: existing, cached: true };
if (existing) await repo.deleteById(workspaceId, existing.id);
const digest = await service.build(…);
```

`routes.ts` is presentation-only: validate → call service → shape response
(`guides/fastify-routing-and-di.md`, bad example #2 is literally "a route handler with
inline branching plus direct `repo.…` calls"). Everything here — the period-window
computation, the cache decision, the regenerate/delete rule — is digest domain logic,
and none of it is reachable from a unit test without booting Fastify. `GET /digests`
(line 52) calls the repository directly too, with no service in the path at all.

**Fix:** collapse both handlers to one service call each, e.g.
`service.generate(workspaceId, { periodDays, regenerate })` returning
`{ digest, cached }`, and `service.list(workspaceId, limit)`. Delete the
`DigestsRepository` import and the `repo` local from `routes.ts`. `memory/routes.ts` is
the right shape in this PR — mirror it.

---

## Blocking — module wiring and test placement

### 8. `server/src/modules/index.ts` — neither module is registered

The PR adds `digests/routes.ts` and `memory/routes.ts` but no registry entry.
`modules/index.ts` is a deliberate static registry (*"ADD A MODULE: create
`modules/<name>/routes.ts` … then add one import + one entry below"* — registration is
static so the same path works under tsx, the bundler and vitest). Without it neither
plugin is ever mounted: every route in this PR 404s, and
`test/digests-service.test.ts:69`'s `expect(res.statusCode).toBe(200)` cannot pass.

**Fix:** add `import digests from './digests/routes.js';` and
`import memory from './memory/routes.js';` plus the two entries in the `modules` map.

### 9. `server/test/digests-service.test.ts:2, 25` — DB-backed test with the wrong filename

It imports `startPg` from `test/helpers/pg.js` and boots a real Postgres, but is named
`*.test.ts`. `TESTING.md`: *"A DB-backed test that imports `test/helpers/pg.ts` must
use the `.it.test.ts` suffix"*; the unit lane runs
`vitest run --exclude '**/*.it.test.ts'` and the integration lane selects `.it.test`,
so as named this file runs in the Docker-free unit lane (silently skipping via
`describe.skip`) and **never runs in the integration lane at all**. SKILL.md states the
same rule: real-Postgres → `*.it.test.ts`.

**Fix:** rename to `server/test/digests.it.test.ts` (matching `reviews.it.test.ts`,
`blast.it.test.ts`, …).

---

## High

### 10. `server/src/modules/digests/helpers.ts:1` — cross-module row type from another module's data layer

```ts
import type { MemoryRow } from '../memory/repository.js';
```

`db/rows.ts` exists precisely so a consumer can reference a row shape *without*
importing another module's data layer, and every owning repository re-exports its row
from there (see `modules/agents/repository.ts:13-14`, `modules/reviews/repository.ts:17-18`).

**Fix:** add `export type MemoryRow = typeof t.memory.$inferSelect;` to
`server/src/db/rows.ts`, have `memory/repository.ts` import-and-re-export it, and have
`digests/helpers.ts` import it from `db/rows.js`. Do the same for `DigestRow`
(`digests/repository.ts:5`) if anything outside the module ends up needing it.

### 11. `server/src/modules/memory/repository/item.repo.ts:4` and `repository/search.repo.ts:4` — aggregates import back from their facade

```ts
import type { InsertMemory, MemoryRow } from '../repository.js';   // item.repo.ts
import type { MemoryRow, NearestOptions } from '../repository.js'; // search.repo.ts
```

while `repository.ts:13-14` imports both files back. That is a cycle between a class and
its own parts. `guides/drizzle-repository-pattern.md` ("Types flow down, not back up")
calls out that this survives review because type-only imports are erased and it still
compiles — the cost is that neither aggregate can be tested or reused without dragging
the facade in. The real `reviews/repository/review.repo.ts:5` takes its types from
`db/rows.ts` instead.

**Fix:** move `MemoryRow` to `db/rows.ts` (per finding 10) and `InsertMemory` /
`NearestOptions` to a module-local `modules/memory/types.ts`; import from there in the
facade *and* both aggregates, so the dependency runs facade → aggregates → types.

The facade-over-two-aggregates split itself is fine and I am **not** flagging it: the
doc comment gives an axis-of-change rationale (schema-shaped writes vs. how pgvector is
tuned), which `guides/pitfalls-and-tradeoffs.md` explicitly accepts as a legitimate
reason to split beyond aggregate count.

### 12. `reviewer-core/src/review/summarize.ts:48–60` — does not type-check against the real APIs

Four separate mismatches; this file cannot compile as written:

- **48–53** `assemblePrompt` takes `PromptParts`, whose field is `system`, not
  `systemPrompt` (`reviewer-core/src/prompt.ts:200-202`).
- **50** `PromptParts.diff` is `diff: string` (a rendered unified diff,
  `prompt.ts:241-242`), not a `UnifiedDiff` object.
- **56–58** `assemblePrompt` returns `{ messages, assembly }` (`prompt.ts:247-250`);
  there is no `prompt.system` / `prompt.user`.
- **55–60** `StructuredRequest` (`server/src/vendor/shared/adapters.ts:55-70`) requires
  `messages: ChatMessage[]` and `schemaName: string`; it has no `system` / `user`
  fields, and `schemaName` is missing.

**Fix:** follow `review/run.ts`'s call shape — build `parts`, destructure
`{ messages }` from `assemblePrompt(...)`, and pass
`{ model, schema, schemaName: 'summary', messages, maxRetries }`.

---

## Medium

### 13. `server/src/modules/digests/service.ts:80–81` — unguarded `container.embedder()`

`Container.embedder()` throws `ConfigError` when `config.embeddingsEnabled` is false,
and its own doc comment states the contract: *"All callers wrap this in try/catch and
degrade gracefully (memory/RAG simply returns no hits)."* `MemoryService.embedOrNull`
(`memory/service.ts:57-65`) honours that; this call does not, so on any workspace with
embeddings disabled the whole digest build throws *after* having already spent one
model call per PR. Routing through `MemoryService.search` (finding 6) fixes this for
free.

### 14. `server/src/modules/digests/repository.ts:14–40` — the digest cache can never hit

The doc comment says periods are *"matched on their exact boundaries"*, but the query
uses `gte(periodStart, …)` / `lte(periodEnd, …)` — a containment range, not equality.
Combined with `routes.ts:33-34`, where `periodEnd = new Date()` on every request, a
stored digest's `periodStart` is always strictly earlier than the next request's
`periodStart`, so `findByPeriod` returns `undefined` forever. The entire reason the
module exists ("a model call over every merged PR … so a digest for a period that was
already built is reused") never takes effect, and every request is billed in full.

**Fix:** either use `eq` on both boundaries and snap the window to day boundaries so the
same period is genuinely recomputable as the same key, or make the intent explicit and
match by overlap. Also note `digests.periodStart` / `periodEnd` / `bodyMd` are all
nullable in `db/schema/ops.ts:41-50` while `InsertDigest` treats them as required —
worth a `.notNull()` migration or a nullable row type.

### 15. `server/src/modules/digests/service.ts:57–62` — assumes every merged PR is in one repo

`repoRow` is looked up from `merged[0]!.repoId` and then used as the `RepoRef` for
*every* PR in the loop (line 69). A workspace with more than one imported repo — the
normal case — will fetch PR numbers against the wrong repository and either 404 or,
worse, silently return a different repo's PR body. Resolve the repo per PR (or batch by
`repoId`) once the query moves behind a repository/service call.

### 16. `server/src/modules/digests/service.ts:53–54` — an empty period is not a 404

`throw new NotFoundError('No pull requests were merged in this period')` turns "a quiet
week" into an HTTP 404 for a resource the caller just asked to create. Prefer returning
an empty/"nothing merged" digest, or a `200` with an explicit empty body.

### 17. `reviewer-core/src/review/summarize.ts:7, 65` — the model is hardcoded

`SUMMARY_MODEL = 'anthropic/claude-3.5-haiku'` pins one vendor's model id inside the
pure core, and returns it as `model`. `ReviewInput.model` is a caller-supplied field for
exactly this reason — the model is a composition-root decision, and an
OpenAI/Anthropic-direct provider would reject an OpenRouter-style slug. Take `model`
from `SummarizeInput`, with the constant at most a default in the caller.
(`server/src/modules/digests/constants.ts:8` has the same string; that one is fine —
a server-side module constant is the right home for it.)

---

## Low / notes

- **`reviewer-core/src/index.ts`** — `summarizeReview` is not exported from the
  package entry point. Add it (with `SummarizeInput` / `SummarizeOutcome`) or the
  server cannot import it through `@devdigest/reviewer-core`.
- **`reviewer-core/src/review/summarize.ts:9–12`** — `z.array(z.custom<Finding>())`
  performs no runtime validation at all, so the structured-output parse cannot catch a
  malformed finding. Use the shared `Finding` Zod schema from `@devdigest/shared`, as
  `review/run.ts` does with `ReviewSchema`.
- **`server/test/digests-service.test.ts:9–13, 43–78`** — the docstring promises "a
  second request for the same window reuses the stored row rather than rebuilding", but
  no such assertion exists. Adding it would have caught finding 14. The test also never
  injects a `github` override (`MockGitHubClient` exists in `adapters/mocks.ts`) — once
  finding 4 is fixed, it must.
- **No tests for the memory module.** `dedupeByContent` (`memory/helpers.ts`) and
  `MemoryService.embedOrNull`'s degrade path are pure and cheap to cover in a plain
  `*.test.ts` with mocked ports; the vector-search path belongs in a `memory.it.test.ts`.

---

## Checked and clean

- `modules/memory/routes.ts` — presentation-only, one service call per handler, Zod
  schemas, no repository or adapter access. This is the shape `digests/routes.ts`
  should copy.
- `modules/memory/service.ts` — depends on `Container` (the documented, accepted
  whole-container injection), constructs only its own repository, no schema import, and
  degrades gracefully on a missing embedder.
- `modules/memory/repository.ts` — facade over `repository/{item,search}.repo.ts` with a
  stated axis-of-change rationale; correct pattern, and not a finding (the only problem
  is the type direction, finding 11).
- `modules/memory/helpers.ts`, `modules/memory/constants.ts`,
  `modules/digests/constants.ts` — pure, I/O-free, correctly placed.
- `modules/digests/repository.ts` — workspace-scoped throughout, owns all its own
  Drizzle access, no leakage upward (its issue is query semantics, finding 14).
- Whole-`Container` injection into services and row types doubling as DTOs are
  documented, intentional compromises in this repo
  (`guides/pitfalls-and-tradeoffs.md`) and are **not** reported here.
