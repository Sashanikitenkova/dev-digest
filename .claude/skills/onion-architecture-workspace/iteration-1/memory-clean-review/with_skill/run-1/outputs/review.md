# PR Review — new `memory` module (`server/src/modules/memory/`)

Reviewed against `.claude/skills/onion-architecture` (SKILL.md + all five guides),
`server/CLAUDE.md`, `TESTING.md`, and the existing modules this one has to sit
next to (`reviews`, `conventions`, `risks`).

## Verdict

**The onion layering is clean.** I found no Dependency Rule violation. What
follows are correctness, tenancy, contract and coverage problems — not layering
ones. Nothing here is unfixable; items 1–3 should block merge.

What I checked and found clean:

- `routes.ts` is presentation-only — Zod `body`/`querystring`/`params` schemas,
  `getContext(...)` for tenancy, one service call per handler, response shaping.
  No repository access, no adapter imports, no business branching.
- `service.ts` takes `Container` and reaches infrastructure only through
  port-typed members (`this.container.embedder()` → the `Embedder` port from
  `vendor/shared/adapters.ts:91`). No `new`-ing of a concrete adapter, no
  `adapters/*` import anywhere in the module. Whole-`Container` injection is the
  documented, accepted compromise (`guides/pitfalls-and-tradeoffs.md:19`).
- All Drizzle access lives under `repository.ts` / `repository/*.repo.ts`.
  Neither `service.ts` nor `routes.ts` imports `db/schema.js` or builds a query.
- The facade-over-aggregate shape mirrors `reviews/repository.ts` exactly (see
  item 11 on whether this domain has earned it, but the shape itself is correct).
- `helpers.ts` / `constants.ts` are pure, I/O-free, and match `conventions/`'s
  file set. No new top-level files outside the module folder.
- No `groundFindings()` concern — nothing here is diff-anchored.
- `DEDUPE_NORMALISE` (`constants.ts:6`) is a module-level `/g` regex, but it is
  only used with `String.replace` (`helpers.ts:18`), which resets `lastIndex`.
  Not a stateful-regex bug.

---

## 1. HIGH — `service.ts:48` awaits `markUsed`, breaking the invariant the code itself states

`repository/item.repo.ts:21` documents the rule:

```
/** Recency feeds ranking later; a failed touch must never fail the read. */
```

But `service.ts:48` is:

```ts
await this.repo.markUsed(rows.map((r) => r.id));
```

An unguarded `await` on an `UPDATE`. A deadlock, a lock timeout, or any
transient DB error on this bookkeeping write rejects the whole `GET
/memory/search` request — the exact failure the comment says must not happen.
The module's own doc comment (`service.ts:22-25`) also promises search "degrades
to returning nothing rather than throwing"; this path throws.

**Fix:** make the touch non-blocking and non-fatal — either
`this.repo.markUsed(ids).catch((err) => log.warn(...))` without `await`, or wrap
the `await` in try/catch that logs and continues. Either way the search result
must be returned regardless.

## 2. HIGH — the module is never registered, so none of these routes exist

`server/src/modules/index.ts` is the static registry, and this PR does not touch
it. `index.ts:23-26` states the rule ("ADD A MODULE: create
`modules/<name>/routes.ts` … then add one import + one entry below"), and
`index.ts:30` literally names `memory` as a module a lesson is expected to add
here. Without the import + the entry in the `modules` record, `memoryRoutes` is
dead code: `POST /memory`, `GET /memory/search` and `DELETE /memory/:id` all 404.

**Fix:** add `import memory from './memory/routes.js';` and a `memory,` entry to
the `modules` object in `server/src/modules/index.ts`. (If that change exists in
the PR but outside the file set I was given, ignore this item — I could not see it.)

## 3. HIGH — every response ships the raw Drizzle row, including the 1536-float embedding

`repository/search.repo.ts:16` does a bare `db.select()` (all columns), and the
routes return those rows untouched: `routes.ts:39` returns `item`, `routes.ts:46`
returns `{ items: ... }`, both typed `MemoryRow` = `typeof t.memory.$inferSelect`
(`repository.ts:16`).

`db/schema/knowledge.ts:21` declares `embedding: vector('embedding', { dimensions: 1536 })`,
so a default 8-result search serializes 8 × 1536 doubles — well over 100 KB of
JSON the UI cannot use — plus internal columns (`workspaceId`, `confidence`,
`sources`) and camelCase field names.

Every comparable module maps to a DTO first: `conventions/service.ts:91` is
`rows.map(toConventionDto)`, producing the snake_case wire shape
(`evidence_path`, `created_at`) that `vendor/shared/contracts/knowledge.ts:219`
defines. `risks/routes.ts` returns a `Risks` contract type. Returning the row
verbatim breaks that convention and the wire naming with it.

Note this is *not* the "row types double as DTOs" compromise the skill tells
reviewers to leave alone (`guides/drizzle-repository-pattern.md:32`) — that
covers internal cross-module type sharing, not putting an embedding vector on
the wire.

**Fix:** select explicit columns in `nearest` (drop `embedding`), add a
`toMemoryDto(row)` to `helpers.ts`, and return that from `service.remember` /
`service.search`.

## 4. MEDIUM — `scope`/`kind` literals re-declared three times instead of imported from `@devdigest/shared`

- `routes.ts:10-11` — `z.enum(['repo','global','team'])`, `z.enum(['decision',…])`
- `service.ts:8-9` — the same union as TS literals
- `repository.ts:21-22` — the same union again

`vendor/shared/contracts/knowledge.ts:87-97` already exports `MemoryScope` and
`MemoryKind` as Zod schemas + inferred types, and `db/schema/knowledge.ts:16-19`
is a fourth copy. `conventions/routes.ts:4` shows the intended pattern
(`import { ConventionStatus } from '@devdigest/shared'`). Four hand-maintained
copies of one enum will drift, and the drift only surfaces as a runtime DB
constraint error.

Related: `knowledge.ts:105-112` also defines a `MemoryItem` wire contract with
`confidence` and `sources` — neither of which this module ever populates
(`insertItem` omits both, so they stay NULL). Worth deciding now whether the
module targets that contract or whether the contract needs revising; shipping a
third, undeclared response shape is the worst of the three options.

**Fix:** import `MemoryScope`/`MemoryKind` from `@devdigest/shared` and use them
in the Zod body schema and as the TS types in `RememberInput`/`InsertMemory`.

## 5. MEDIUM — `repoId` is never verified to belong to the caller's workspace

`routes.ts:13` validates only that `repoId` is a uuid, and `service.remember`
(`service.ts:36`) passes it straight into the insert. The FK
(`0000_init.sql:382`) proves only that the repo exists *somewhere*, not that it
is in this workspace. So a caller can attach a memory row to another workspace's
repo. The same unchecked id is used as a filter in `search`.

`conventions/service.ts:116` does the check the right way before acting:
`const repo = await this.repo.getRepo(workspaceId, repoId);`

**Fix:** add a workspace-scoped `getRepo(workspaceId, repoId)` to
`repository/item.repo.ts` and have `remember` throw `NotFoundError` when the repo
does not resolve within the workspace.

## 6. MEDIUM — `scope` is written but never read, and the `repoId` filter hides global memories

`repository/search.repo.ts:19-25` filters on `workspaceId`, `isNotNull(embedding)`
and — when supplied — `eq(t.memory.repoId, opts.repoId)`. `scope` appears in no
query in the module.

Two consequences:

- Passing `repoId` (which any repo-scoped panel will do) **excludes every
  `global` and `team` memory**, because those rows have `repo_id IS NULL` and
  fail the equality. That inverts the point of having scopes: the broadest
  memories disappear precisely when you scope a search.
- `RememberBody` (`routes.ts:9-14`) accepts `scope: 'repo'` with no `repoId`, and
  `scope: 'global'` *with* one. Neither combination is rejected, and the second
  is then silently un-findable by a global search.

**Fix:** make `nearest`'s repo predicate `or(eq(repoId, x), isNull(repoId))` (or
an explicit scope predicate), and add a `.superRefine` to `RememberBody`
requiring `repoId` iff `scope === 'repo'` and forbidding it otherwise.

## 7. MEDIUM — a transient embed failure permanently and silently makes an item unsearchable

`service.ts:57-65`:

```ts
try { … } catch { return null; }
```

The catch is total and silent. On the `remember` path that stores
`embedding: null` (`service.ts:36`), and `nearest` filters `isNotNull(embedding)`
(`search.repo.ts:22`) — so the item is written, reported back to the user as a
201 success, and can never be retrieved. There is no backfill or re-embed path
in the module, and nothing is logged.

The *disabled-embeddings* case is legitimate and documented —
`platform/container.ts:203-216` throws `ConfigError` before constructing any
client precisely so "callers wrap this in try/catch and degrade gracefully". But
an OpenAI 429/500/timeout lands in exactly the same catch and is treated as a
permanent, silent config decision.

**Fix:** distinguish `ConfigError` (degrade quietly, as designed) from anything
else (log a warning via `req.log`, and either fail the write or record the item
for re-embedding). At minimum, log — the module currently has no logging at all,
whereas `conventions/routes.ts:34` threads `req.log` into its service.

## 8. MEDIUM — no tests ship with the module

`helpers.ts:3` says "Pure list shaping — no I/O, so it is unit-testable on its
own", and then no test exists. `server/test/` has `risks-helpers.test.ts`,
`blast-helpers.test.ts`, `reviews-helpers.test.ts`, `skills-helpers.test.ts` for
exactly this shape of file, plus an `*.it.test.ts` per data-backed workflow.

The two things most likely to break here are the pgvector query and workspace
scoping — TESTING.md's stated reason for requiring a real-Postgres integration
test ("the bugs there live in SQL, migrations, and wiring").

**Fix:** add `server/test/memory-helpers.test.ts` for `dedupeByContent`, and
`server/test/memory.it.test.ts` covering remember → search → forget, the
cross-workspace isolation case, and the null-embedding row being excluded.
Remember the naming rule in `server/CLAUDE.md:41` — a DB-backed test **must** be
`*.it.test.ts` or the unit/integration split miscategorizes it. Per
`server/INSIGHTS.md`, inject **every** provider the path can reach
(`embedder` *and* `llm.openai`, since `container.embedder()` resolves through
`llm('openai')`) or the test will silently hit the real network.

## 9. LOW — `markUsed` is the only write in the module that is not workspace-scoped

`repository/item.repo.ts:22-24` updates `where(inArray(t.memory.id, ids))` with
no workspace predicate. It is safe today only because the ids come from the
workspace-scoped `nearest`. Every other method in this repository — and in
`conventions/repository.ts`, `reviews/repository.ts` — takes `workspaceId`.

**Fix:** `markUsed(db, workspaceId, ids)` with
`and(eq(t.memory.workspaceId, workspaceId), inArray(...))`. Cheap defence in depth.

## 10. LOW — dedupe runs after the SQL `LIMIT`, so search silently under-returns

`service.ts:43-49` limits to 8 in SQL, then `dedupeByContent` drops duplicates in
memory. `helpers.ts:10-12` says near-duplicates are *common* ("the same decision
gets remembered from several PRs"), so the common case returns fewer than the
requested `limit` with no way to top up.

**Fix:** over-fetch (`limit * 2`, capped), dedupe, then `slice(0, limit)`.

## 11. LOW — the facade-over-aggregate split is slightly ahead of the domain

`repository.ts` composes `item.repo.ts` + `search.repo.ts` for four queries over
one table. `guides/drizzle-repository-pattern.md:13` scopes this pattern to
"a domain [that] covers multiple aggregates", and
`guides/pitfalls-and-tradeoffs.md:9` explicitly warns against scaffolding it "for
a module that will only ever need two queries", contrasting `settings/` with
`reviews/` (three aggregates, real orchestration).

The doc comment at `repository.ts:7-10` argues the split on axis-of-change rather
than aggregates, which is a defensible reading — I am flagging it as a judgement
call to make consciously, not as a defect. If the module is expected to grow
ranking/decay/consolidation, keep it. If not, one `repository.ts` is closer to
proportionate. **Not a blocker either way.**

## 12. LOW — circular type import between the facade and its aggregate files

`repository/item.repo.ts:4` and `repository/search.repo.ts:4` import
`InsertMemory`/`MemoryRow`/`NearestOptions` from `../repository.js`, which
imports both files back (`repository.ts:13-14`). These are `import type`, so they
are erased and there is no runtime cycle — this is not a bug today. But it is not
how the pattern's reference implementation does it:
`reviews/repository/review.repo.ts` declares its own row type and pulls shared
ones from `db/rows.js`, keeping the dependency one-directional.

**Fix (optional):** move the shared types to `modules/memory/types.ts` (the shape
`repo-intel/types.ts` already uses) and have all three files import from there.

## 13. LOW — no vector index, and no per-route limit on the two routes that spend money

- `nearest` orders by `<=>` over a full table scan: `0000_init.sql:407` creates
  only `memory_ws_idx` (btree on `workspace_id`), and there is no ivfflat/hnsw
  index anywhere in `db/migrations/*.sql`. Fine at studio scale; add an HNSW
  index (`vector_cosine_ops`, matching the `<=>` operator) before this table
  grows past a few thousand rows.
- `POST /memory` and `GET /memory/search` each trigger an OpenAI embedding call
  and rely solely on the global limiter (`app.ts:102`). `reviews/routes.ts:29`
  sets a tighter per-route `rateLimit` for exactly this reason ("each call can
  fan out to expensive LLM runs"). A modest per-route cap here would be cheap
  insurance.

The value interpolation in `search.repo.ts:14`
(`sql\`… <=> ${JSON.stringify(embedding)}::vector\``) is **not** an injection
risk — Drizzle's `sql` template binds interpolated values as parameters. Noting
it explicitly so a later reviewer doesn't re-raise it.

---

## Summary

| # | Severity | File:line | Issue |
|---|---|---|---|
| 1 | High | `service.ts:48` | `await markUsed` makes a bookkeeping write fatal to search, against the stated invariant |
| 2 | High | `modules/index.ts` (absent) | module never registered — all three routes 404 |
| 3 | High | `routes.ts:39,46` / `repository/search.repo.ts:16` | raw row returned incl. 1536-float embedding; no DTO, wrong wire casing |
| 4 | Medium | `routes.ts:10`, `service.ts:8`, `repository.ts:21` | scope/kind enums re-declared instead of imported from `@devdigest/shared` |
| 5 | Medium | `routes.ts:13` / `service.ts:36` | `repoId` never validated against the caller's workspace |
| 6 | Medium | `repository/search.repo.ts:19-25`, `routes.ts:9-14` | `scope` never queried; `repoId` filter excludes global/team memories |
| 7 | Medium | `service.ts:57-65` | blanket catch turns a transient embed failure into permanent, silent unsearchability |
| 8 | Medium | (no test files) | no unit or `*.it.test.ts` coverage for a DB- and pgvector-backed module |
| 9 | Low | `repository/item.repo.ts:22-24` | `markUsed` not workspace-scoped |
| 10 | Low | `service.ts:43-49` | dedupe after `LIMIT` under-returns |
| 11 | Low | `repository.ts:7-14` | facade-over-aggregate split ahead of actual complexity (judgement call) |
| 12 | Low | `repository/item.repo.ts:4`, `search.repo.ts:4` | circular type import; diverges from the reference implementation |
| 13 | Low | `repository/search.repo.ts:14-27`, `routes.ts:36,43` | no vector index; no per-route rate limit on embedding-spending routes |

Layering: no violations found.
