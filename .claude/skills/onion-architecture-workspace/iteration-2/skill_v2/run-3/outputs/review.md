# PR Review — `digests` + `memory` modules, `reviewer-core/review/summarize.ts`

Reviewed against `.claude/skills/onion-architecture` (SKILL.md + all five guides), the
existing conventions in `server/src/platform/container.ts`,
`server/src/vendor/shared/adapters.ts`, `server/src/modules/reviews/*`,
`server/src/db/rows.ts`, `reviewer-core/src/index.ts` / `CLAUDE.md`, and `TESTING.md`.

**Verdict: request changes.** Four blocking (Critical) violations, four High, two Medium,
three Low. The `memory` module is close to clean; `digests` and `summarize.ts` both
collapse several rings into one file.

---

## Critical

### 1. `reviewer-core/src/review/summarize.ts:55-66` — bypasses the mandatory grounding gate

```ts
const result = await llm.completeStructured({ ... });
return { headline: result.data.headline, findings: result.data.findings, model: SUMMARY_MODEL };
```

Raw model output is returned as `Finding[]` with no call to `groundFindings()`. This is
the one invariant `reviewer-core/CLAUDE.md` calls non-negotiable ("Grounding is mandatory —
never bypass `groundFindings()` or trust the model's self-reported score"), and the root
`CLAUDE.md` repeats it ("every finding must cite a real diff line or it's dropped").
`summarize.ts` receives the `UnifiedDiff` already (`SummarizeInput.diff`), so there is no
excuse for skipping the gate — every hallucinated line number the model emits will flow
straight to the PR page, above the fold.

**Fix:** pipe the findings through `groundFindings(result.data.findings, input.diff)` and
return only `kept`. If a headline-only pass is genuinely wanted, drop `findings` from the
return type rather than returning ungrounded ones.

### 2. `reviewer-core/src/review/summarize.ts:5, 39-41` — constructs a concrete provider and reads an API key inside the pure core

```ts
import { OpenRouterProvider } from '../llm/openrouter.js';
...
const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error('OPENROUTER_API_KEY is not configured');
const llm = new OpenRouterProvider(key, { timeoutMs: 60_000 });
```

`reviewer-core/src/index.ts` states the boundary: "the only side effect is an LLM call
through an INJECTED LLMProvider (so it is mock-testable)". `guides/reviewer-core-llm-port.md`
names this exact anti-pattern: "`review/run.ts` or `prompt.ts` … constructing an
`OpenRouterProvider`/reading `process.env.OPENROUTER_API_KEY` internally instead of
receiving `llm` as a parameter". `llm/openrouter.ts` living inside the package is the
documented exception *because it is only ever constructed at each consumer's composition
root* (`container.ts`'s `buildLlm()`); constructing it here breaks that guarantee.

It also breaks two repo conventions at once: secrets live in `~/.devdigest/secrets.json`
behind `SecretsProvider`, never in env (root `CLAUDE.md`), and `reviewer-core` currently
contains zero `process.env` references anywhere (verified by grep) — this file would be
the first.

**Fix:** add `llm: LLMProvider` to `SummarizeInput` and delete the import, the env read,
and the `new`. Callers (`server`'s container path, the CI runner) already resolve a
provider; pass it in, exactly as `ReviewInput.llm` does in `review/run.ts:53`.

### 3. `reviewer-core/src/review/summarize.ts:1, 44-46` — filesystem access inside `reviewer-core`

```ts
import { readFile } from 'node:fs/promises';
...
for (const path of input.skillPaths ?? []) skills.push(await readFile(path, 'utf8'));
```

`reviewer-core` is defined by "NO database, GitHub, or filesystem access"
(`src/index.ts`). `ReviewInput` in `review/run.ts:56-66` shows the established contract for
exactly this data: "Resolved skill bodies (**NOT** slugs)" and, for specs, "resolved by the
CALLER (reviewer-core does no I/O — the studio reads them off the clone, the runner off the
filesystem)". `SummarizeInput.skillPaths` (line 19-20, "Absolute paths of the skill files")
inverts that contract for no gain, and makes the function untestable without a fixture
directory on disk.

**Fix:** replace `skillPaths?: string[]` with `skills?: string[]` carrying already-read
bodies, and delete the `node:fs/promises` import. Resolution moves to the caller in
`server/`, mirroring how `ReviewService` resolves skill bodies today.

### 4. `server/src/modules/digests/service.ts:2, 64` — concrete adapter constructed outside the composition root, with a secret from `process.env`

```ts
import { OctokitGitHubClient } from '../../adapters/github/octokit.js';
...
const github = new OctokitGitHubClient(process.env.GITHUB_TOKEN ?? '');
```

`guides/layer-model.md` is explicit: "If you find yourself importing from
`server/src/adapters/*` anywhere outside `container.ts`, that's a Dependency Rule
violation." `container.github()` (`platform/container.ts:161-168`) already does this
correctly — it resolves `GITHUB_TOKEN` through `this.secrets`, throws a typed `ConfigError`
when missing, caches the client, and honours `ContainerOverrides.github`.

Two concrete consequences, not just style: (a) secrets are supposed to come from
`~/.devdigest/secrets.json` via `SecretsProvider`, never env (root `CLAUDE.md`); the
`?? ''` silently degrades a missing token into unauthenticated GitHub calls that fail later
with a confusing 401/403 instead of `ConfigError`. (b) `ContainerOverrides.github` is
bypassed, so `test/digests-service.test.ts` — which overrides `llm`, `embedder` and `git`
but cannot override this — will make **real network calls to github.com** on every merged
PR in the window.

**Fix:** `const github = await this.container.github();` and delete the import and the env read.

---

## High

### 5. `server/src/modules/digests/service.ts:1, 5, 32-60` — service builds Drizzle queries directly

```ts
import { and, desc, eq, gte } from 'drizzle-orm';
import * as t from '../../db/schema.js';
...
const merged = await this.container.db.select({...}).from(t.pullRequests)...
const [repoRow] = await this.container.db.select({...}).from(t.repos)...
```

The module already has a `DigestsRepository`, and the service still reaches around it into
`container.db`. `guides/drizzle-repository-pattern.md` names this exact shape as the bad
example ("a service or route file with `import * as t from '../../db/schema.js'` and its own
`db.select()...` inline"), and `reviews/repository.ts`'s doc comment states the invariant
this breaks: "The ONLY layer touching the DB for the review domain." No `service.ts` in this
repo imports `db/schema.js`.

Note these are also *other domains'* tables (`pull_requests`, `repos`), not `digests` — see
finding 6 for the same problem in its cross-module form.

**Fix:** move both queries behind methods on `DigestsRepository`
(e.g. `listMergedPulls(workspaceId, periodStart, limit)`, `getRepoRef(repoId)`), or, for
`pull_requests` specifically, use the cross-cutting `container.reviewRepo` which already
owns pull lookups. Drop `drizzle-orm` and `db/schema.js` from the service's imports entirely.

### 6. `server/src/modules/digests/service.ts:6, 83` — reaches into another module's per-aggregate repository file

```ts
import { nearest } from '../memory/repository/search.repo.js';
...
const related = await nearest(this.container.db, workspaceId, queryVector, { limit: RELATED_MEMORY_LIMIT });
```

Two rules broken at once. `guides/drizzle-repository-pattern.md` calls importing
`repository/<aggregate>.repo.ts` directly "the inverse mistake … which defeats the point of
having a stable composed API" — `MemoryRepository.nearest()` exists precisely to be that
API. And `container.ts:71-73` states the cross-module convention in its own words:
"Shared repositories for cross-cutting entities … so consuming modules use
`container.agentsRepo` instead of reaching into another module's folder."

The coupling is real: `search.repo.ts`'s signature and its `Db`-first parameter shape are
private implementation detail of `memory`, and `digests` now pins them.

**Fix:** depend on `memory`'s public surface — construct a `MemoryService` (or
`MemoryRepository`) from the container in `DigestsService`, or, if this becomes a genuinely
cross-cutting need, add a `memoryRepo` getter to `Container` alongside `agentsRepo` /
`reviewRepo`. Do not import from `../memory/repository/*`.

### 7. `server/src/modules/digests/routes.ts:6, 28, 36-46, 52` — route owns data access and business branching

```ts
const repo = new DigestsRepository(app.container.db);
...
const existing = await repo.findByPeriod(workspaceId, periodStart, periodEnd);
if (existing && !req.body.regenerate) return { digest: existing, cached: true };
if (existing) await repo.deleteById(workspaceId, existing.id);
const digest = await service.build(...);
```

`guides/fastify-routing-and-di.md`: a `routes.ts` "does not contain business logic,
branching on domain state, or direct repository/adapter calls", and the bad example is
literally "a route handler with inline `if (...) { ... } else { ... }` branching plus direct
`repo.insertReview(...)` calls". No `routes.ts` in this repo constructs a repository
(verified by grep across `src/modules/*/routes.ts`).

The reuse-vs-rebuild decision, the period-window arithmetic (line 33-34) and the
delete-then-rebuild sequence are the module's core policy — the doc comment on lines 21-23
describes them as such — and they currently cannot be unit-tested without booting Fastify.
The `GET` handler (line 52) is the same violation in miniature.

**Fix:** give `DigestsService` a single `generate(workspaceId, { periodDays, regenerate })`
that computes the window, checks/invalidates the cached row and builds; and a
`listRecent(workspaceId, limit)`. The handlers become parse → one service call → shape,
and `DigestsRepository` disappears from `routes.ts`.

### 8. `server/src/modules/index.ts` — neither new module is registered

The PR adds `modules/digests/routes.ts` and `modules/memory/routes.ts` but contains no
change to `src/modules/index.ts`, which is the static registry `app.ts:192-194` iterates to
register plugins. Its own doc comment: "ADD A MODULE: create `modules/<name>/routes.ts`
exporting a default Fastify plugin, then add one import + one entry below." The SKILL's
checklist repeats it: "registered once in `modules/index.ts` — no bypassing the static
registry."

As shipped, neither module's routes are mounted; `test/digests-service.test.ts` would get a
404 on `POST /digests`, not the 200 it asserts.

**Fix:** add `import digests from './digests/routes.js';` / `import memory from
'./memory/routes.js';` and the two matching entries in the `modules` record.

---

## Medium

### 9. `server/src/modules/memory/repository/item.repo.ts:4` and `search.repo.ts:4` — aggregates import types back from the facade

```ts
// item.repo.ts
import type { InsertMemory, MemoryRow } from '../repository.js';
// search.repo.ts
import type { MemoryRow, NearestOptions } from '../repository.js';
```

`repository.ts:13-14` imports both aggregate files, so the dependency is a cycle between a
class and its own parts. `guides/drizzle-repository-pattern.md` covers exactly this: "It
usually still compiles — type-only imports are erased — which is exactly why it survives
review. The cost is real anyway: the aggregate can no longer be tested or reused without
dragging the whole facade in." The established counter-example is right next door —
`reviews/repository/review.repo.ts:5` takes its row types from `../../../db/rows.js`,
never from `../repository.js`.

**Fix:** move `MemoryRow`, `InsertMemory` and `NearestOptions` into a module-local
`modules/memory/types.ts` (or `MemoryRow` into `db/rows.ts` if other modules will need it —
see finding 6), and have `repository.ts` and both aggregate files import from there, so the
dependency runs facade → aggregates → types. `repository.ts` can re-export them to keep its
public type API unchanged, the way `reviews/repository.ts:17-18` does.

*(To be explicit: the facade-over-`repository/<aggregate>.repo.ts` split itself is the
documented convention, and the doc comment justifying it on churn grounds — "they share a
table but not a reason to change" — is exactly the right justification. Not a finding.)*

### 10. `server/test/digests-service.test.ts` — DB-backed test in the unit lane

The file imports `./helpers/pg.js` and starts a real Postgres via `startPg()` (line 25),
but is named `digests-service.test.ts`. `TESTING.md`: "A DB-backed test that imports
`test/helpers/pg.ts` must use the `.it.test.ts` suffix" — the unit lane runs
`vitest run --exclude '**/*.it.test.ts'`, so as named this test will try to spin up Docker
in the fast, hermetic lane. The SKILL states the same rule as a ring-placement signal:
"mocked-ports-only → `*.test.ts`; real-Postgres → `*.it.test.ts`."

**Fix:** rename to `test/digests.it.test.ts` (matching `reviews.it.test.ts`,
`blast.it.test.ts`, …).

Secondary, and it disappears once finding 4 is fixed: the `overrides` block (lines 30-34)
covers `llm`, `embedder` and `git` but not `github`, because the service constructs its own
GitHub client. Add `github: new MockGitHubClient()` (or whichever mock
`src/adapters/mocks.ts` exposes) once the service resolves it from the container — otherwise
this test hits the network.

---

## Low / non-blocking

### 11. `reviewer-core/src/review/summarize.ts:7` — model id hard-coded in the core

`const SUMMARY_MODEL = 'anthropic/claude-3.5-haiku';` bakes a provider-specific model
string into the engine. `ReviewInput.model` (`review/run.ts:48-49`) takes it as a parameter
precisely so the caller owns model choice — the studio and the CI runner do not necessarily
use the same one. Move it to `SummarizeInput.model`; the default can live in the caller
(`server/src/modules/digests/constants.ts:8` already does this for its own model).

### 12. `reviewer-core/src/review/summarize.ts:11` — `z.array(z.custom<Finding>())` validates nothing

`z.custom<Finding>()` with no validator accepts any value at runtime and only asserts the
type to the compiler, so `completeStructured` returns unchecked model output typed as
`Finding[]`. Use the real `Finding` schema (as `review/run.ts` does) so a malformed payload
fails at the boundary rather than downstream. Largely moot once finding 1 routes everything
through `groundFindings()`, but worth fixing together.

### 13. `reviewer-core/src/review/summarize.ts` — not exported from `src/index.ts`

`reviewer-core/src/index.ts` is the package's public surface and lists every consumable
entry point. A new engine pass that consumers are meant to call should be exported there;
if it is internal-only, that is worth a line in the doc comment.

---

## Checked and clean

- `server/src/modules/memory/{routes,service,helpers,constants}.ts` — routes are
  parse → one service call → shape; the service takes `Container` and resolves the embedder
  through `container.embedder()` (a port), never a concrete adapter; all Drizzle stays
  behind `MemoryRepository`. Aside from finding 9 this module is the shape the skill asks for.
- `server/src/modules/digests/{repository,helpers,constants}.ts` — the repository is the
  correct shape for its own table, and `helpers.ts` / `constants.ts` as pure side files
  mirror `modules/settings/`; layering depth is proportionate to the domain
  (`guides/pitfalls-and-tradeoffs.md`). No finding.
- Whole-`Container` injection into both services, and row types (`DigestRow`, `MemoryRow`)
  doubling as DTOs — documented, intentional compromises in this repo; deliberately not
  reported.
- `digests` and `memory` tables already exist in `src/db/schema/{ops,knowledge}.ts`, so no
  migration is missing from this PR.
