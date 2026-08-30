# PR Review — `server/src/modules/memory/`

Reviewed against `.claude/skills/onion-architecture` (SKILL.md + `guides/layer-model.md`,
`guides/fastify-routing-and-di.md`, `guides/drizzle-repository-pattern.md`,
`guides/pitfalls-and-tradeoffs.md`), plus `server/CLAUDE.md`, `server/INSIGHTS.md`
and the existing `reviews`/`settings` modules as the canonical examples.

**Verdict: request changes.** The onion layering in this PR is genuinely clean — I found
no Dependency-Rule violation (details in "What's correct" at the end). Everything below is
a correctness, data-shape, operational or test-coverage problem, not a layering one.

Paths below are relative to the fixture root
(`fixtures/memory-clean/server/src/modules/memory/`), i.e. as they would land at
`server/src/modules/memory/`.

---

## Blocking

### 1. `markUsed` is awaited unguarded, so a bookkeeping failure 500s a read

`service.ts:48` — `await this.repo.markUsed(rows.map((r) => r.id));`

`repository/item.repo.ts:21` documents the exact opposite invariant:

> `/** Recency feeds ranking later; a failed touch must never fail the read. */`

and `service.ts:19-26` promises "search degrades to returning nothing rather than
throwing — the panel that renders it is one of several on the page and must not take
the others down with it." Neither holds: `markUsed` is a plain `await` on an `UPDATE`.
A lock timeout, a statement timeout, or a dropped connection on the *write* turns a
successful *read* into a 500 and takes the panel down — the precise failure the doc
comment says is unacceptable.

**Fix:** make the touch fire-and-forget with an explicit catch, and log rather than
swallow, e.g.

```ts
this.repo.markUsed(rows.map((r) => r.id)).catch(() => {/* recency is best-effort */});
```

If you keep the `await` (for test determinism), wrap it in `try/catch`. Either way the
behaviour must match the two comments that already describe it.

### 2. Both routes return the raw row, including the 1536-float embedding

- `routes.ts:38-40` — `POST /memory` returns `item`, a full `MemoryRow`.
- `routes.ts:46` — `GET /memory/search` returns `{ items: rows }`, up to 50 full rows.
- `repository/search.repo.ts:17` — `db.select()` with no column list, so `embedding` is
  selected.
- `repository.ts:16` — `MemoryRow = typeof t.memory.$inferSelect`, which includes
  `embedding: number[] | null` (`db/schema/knowledge.ts:21`, `vector(1536)`).

Neither route declares a `response` schema, and the repo's `serializerCompiler` only
filters when one is present — so the vector goes over the wire verbatim. One row is
roughly 20–30 KB of JSON; `GET /memory/search?limit=50` is ~1 MB of embedding floats
that no client can use. It is also wasted DB→app transfer and JSON serialization on
every single search.

**Fix:** stop selecting the column and stop returning it. Give `search.repo.ts` an
explicit column list (all fields except `embedding`) and introduce a `MemoryDto` the
service returns — the `reviews` module already has this shape in
`modules/reviews/helpers.ts` (`reviewToDto`, `findingRowToDto`). Declaring a Zod
`response` schema on both routes as a second line of defence would be a bonus.

### 3. No vector index on `memory.embedding` — every search is a sequential scan

`repository/search.repo.ts:14,26` order by `embedding <=> $vector`. The only index on
the table is `memory_ws_idx` on `workspace_id` (`db/schema/knowledge.ts:28`;
`db/migrations/0000_init.sql:407`). There is no HNSW or IVFFlat index, and this PR adds
no migration.

Result: every `/memory/search` reads the whole workspace's `memory` rows and computes a
1536-dimension cosine distance for each. That is fine at 50 rows and quietly unusable at
50,000 — which is exactly what a "remember every decision from every PR" feature
accumulates.

**Fix:** add a migration creating the index, e.g.
`CREATE INDEX memory_embedding_idx ON memory USING hnsw (embedding vector_cosine_ops);`
(the operator class must match `<=>`; the pgvector extension is already enabled in
migration 0000). Per `server/CLAUDE.md`, generate it via `pnpm db:generate` /
hand-write it under `src/db/migrations/`, and remember migrations are **not** applied on
boot — the PR description should say `pnpm db:migrate` is required. Note also that the
composite predicate is `workspace_id = ? AND embedding IS NOT NULL` plus an ORDER BY on
distance; consider a partial index (`WHERE embedding IS NOT NULL`) so null-embedding rows
never enter it.

### 4. The module is never registered — the routes do not exist at runtime

`server/src/modules/index.ts:32-49` lists sixteen modules and `memory` is not among
them; `app.ts:194` registers only `Object.values(modules)`. Nothing in this PR adds the
import or the registry entry, so `POST /memory`, `GET /memory/search` and
`DELETE /memory/:id` are dead code once merged.

The skill's checklist states it explicitly: *"New module = routes.ts + service.ts +
repository.ts (as needed), **registered once in `modules/index.ts`** — no bypassing the
static registry"*, and `modules/index.ts:23-30` gives the two-line recipe (one import,
one entry) and even names `memory` as a planned lesson module.

**Fix:** add `import memory from './memory/routes.js';` and a `memory,` entry to the
`modules` record. If the PR does touch that file and it simply was not included in the
fixture, disregard this item — but confirm it, because nothing else mounts the plugin.

---

## Should fix before merge

### 5. `embedOrNull` swallows every failure silently, and nothing ever backfills

`service.ts:57-65`:

```ts
private async embedOrNull(text: string): Promise<number[] | null> {
  try { ... } catch { return null; }
}
```

The bare `catch` is right for one case and wrong for the other:

- **Embeddings disabled** (`container.embedder()` throws `ConfigError` —
  `platform/container.ts:209-211`). Degrading is correct and is the documented contract:
  *"All callers wrap this in try/catch and degrade gracefully (memory/RAG simply returns
  no hits)."* Good.
- **A transient embedder failure** (OpenAI 429/500, timeout, expired key). Here the
  behaviour is data loss with a success status: `remember` still returns **201** and
  persists a row whose `embedding` is `null`. `search.repo.ts:22` filters
  `isNotNull(t.memory.embedding)`, so that memory is invisible to search **forever** —
  there is no retry, no backfill job, and no way for the user to tell that the thing they
  asked the product to remember was silently dropped from recall.

Also: nothing is logged. The route has `req.log` available and `server/INSIGHTS.md` has a
whole entry about a silent provider fallthrough that "did not fail loudly" and pointed
nowhere near its cause. This is the same trap.

**Fix, minimum:** log the caught error (warn level) with the reason. **Better:**
distinguish "embeddings disabled" (degrade quietly) from "embedder errored" (log, and
either surface a flag on the 201 response, e.g. `{ ...dto, embedded: false }`, or reject),
and add a way to re-embed null-embedding rows — even a `POST /memory/reembed`
maintenance route or a `JobRunner` task would close the hole.

### 6. No tests at all

The PR ships no `*.test.ts` and no `*.it.test.ts`, in a repo whose `server/test/`
directory has ~40 test files and a per-module `<module>-helpers.test.ts` convention
(`reviews-helpers.test.ts`, `brief-helpers.test.ts`, `intent-helpers.test.ts`,
`risks-helpers.test.ts`, …). The PR's own comments advertise testability it did not
deliver: `constants.ts:1` ("kept out of the service so tests can read them") and
`helpers.ts:3` ("no I/O, so it is unit-testable on its own").

**Fix — at least these three:**
- `test/memory-helpers.test.ts` — `dedupeByContent`: case/whitespace folding, first-wins
  ordering, empty input.
- `test/memory.test.ts` — `MemoryService` with `overrides.embedder` (a `MockEmbedder`
  already exists at `adapters/mocks.ts:114`) and a stub repository: the embedder-throws
  path, `search` returning `[]` with no embedding, and `forget` raising `NotFoundError`.
- `test/memory.it.test.ts` — the pgvector query against real Postgres (workspace scoping,
  the `repoId` filter, ordering). Per `server/CLAUDE.md`, a DB-backed test **must** be
  named `*.it.test.ts` or the unit/integration split silently miscategorizes it; and per
  `server/INSIGHTS.md` (2026-08-11), inject **every** provider that path can reach —
  `embedder` here resolves through `llm('openai')`, so omitting the override makes live,
  billed calls without failing loudly.

### 7. Dedupe runs after `LIMIT`, and `markUsed` touches rows that get dropped

`service.ts:43-49`:

```ts
const rows = await this.repo.nearest(workspaceId, embedding, { ..., limit: opts.limit ?? DEFAULT_SEARCH_LIMIT });
await this.repo.markUsed(rows.map((r) => r.id));
return dedupeByContent(rows);
```

Two consequences:

1. `limit` is applied in SQL and deduplication happens in memory afterwards, so a caller
   asking for 8 can get 2. `helpers.ts:10-13` says near-duplicates are *"common because
   the same decision gets remembered from several PRs"* — i.e. the shortfall is expected
   to be the normal case, not an edge case.
2. `markUsed` stamps `last_used_at` on rows the user never sees, which corrupts the very
   recency signal `item.repo.ts:21` says will "feed ranking later".

**Fix:** over-fetch (e.g. `limit * 3`, capped) then dedupe then `slice(0, limit)`, and
call `markUsed` on the **returned** ids only. Alternatively dedupe in SQL with
`DISTINCT ON` over a normalized content expression — but that would need the same
normalization as `helpers.ts:18`, so the over-fetch is the simpler correct option.

### 8. No relevance floor and no score returned

`repository/search.repo.ts:8-27` computes the distance purely to sort by it; it is never
selected, never thresholded, and never returned. So a query with no genuinely related
memory still returns the 8 least-unrelated rows, presented to the user as recalled
memories. The client also has no score to rank, group or grey-out with.

**Fix:** select the distance as a column (`.select({ ...cols, distance })`), return it on
the DTO, and apply a maximum-distance cutoff — either in SQL (`HAVING`/`WHERE distance <
threshold`) or in the service — with the threshold in `constants.ts` next to
`DEFAULT_SEARCH_LIMIT`.

### 9. `scope` and `repoId` are never cross-validated, and `repoId` is not workspace-checked

`routes.ts:9-14` accepts any combination of `scope` and `repoId`:

- `{ scope: 'repo' }` with no `repoId` persists a repo-scoped memory attached to no repo.
  `search.repo.ts:23` only applies `eq(t.memory.repoId, opts.repoId)` when a `repoId` is
  supplied, so such a row can never be reached by the repo-filtered search it was created
  for.
- `{ scope: 'global', repoId: '<uuid>' }` is accepted and the `repoId` is silently
  persisted, giving two contradictory sources of truth for the row's reach.
- Nothing checks that `repoId` belongs to the caller's workspace. `service.ts:34-37`
  passes it straight through to the insert, and the FK
  (`db/schema/knowledge.ts:15`) is global, not workspace-scoped — so a caller can attach
  a memory to another workspace's repo id. `modules/_shared/context.ts:9-13` states the
  house rule: *"Every module uses this so workspace scoping is never forgotten."*

**Fix:** add a `.superRefine` / `.refine` on `RememberBody` requiring `repoId` when
`scope === 'repo'` and forbidding it otherwise; and have the service verify the repo
belongs to `workspaceId` before insert (`ReviewRepository.getRepo` exists but is itself
unscoped, so add a workspace-scoped lookup rather than reusing it).

### 10. No per-route rate limit on the two routes that spend money

`routes.ts:36` and `routes.ts:43` register with a `schema` only. Each request triggers an
embedding API call (`service.ts:35,40`). The repo's convention is a tight per-route limit
on exactly these routes: `reviews/routes.ts:29` (`max: 10`), `brief/routes.ts:52,69`,
`intent/routes.ts:43`, `settings/routes.ts:72` — all with the comment rationale "each call
can fan out to expensive LLM runs". The global limiter (`app.ts:102`,
`DEVDIGEST_RATE_LIMIT_MAX`) is far looser and is disabled under `NODE_ENV=test`.

**Fix:** add `config: { rateLimit: { max: 10, timeWindow: '1 minute' } }` (or similar) to
`POST /memory` and `GET /memory/search`.

---

## Minor / nits

### 11. The `scope`/`kind` unions are declared four times

`routes.ts:10-11`, `service.ts:8-9`, `repository.ts:21-22`, and
`db/schema/knowledge.ts:16-19`. Adding a sixth `kind` means four coordinated edits, and
nothing fails if you miss one — the route would 422 while the DB happily accepts it, or
vice versa.

**Fix:** declare the two `z.enum`s once (in `constants.ts` or a small `types.ts`) and
derive the TS unions with `z.infer`; ideally seed the enum arrays from the Drizzle column
enums so the schema stays the single source of truth.

### 12. Type-import cycle between the facade and its aggregate files

`repository.ts:13-14` imports `./repository/item.repo.js` and `./repository/search.repo.js`,
while `repository/item.repo.ts:4` and `repository/search.repo.ts:4` import
`InsertMemory` / `MemoryRow` / `NearestOptions` back from `../repository.js`. Both
directions are `import type`, so with `isolatedModules: true` they erase and there is no
runtime cycle — this is not a bug today, just fragile: the moment someone drops the
`type` keyword on one of those, it becomes a real circular import.

The existing convention avoids it: `reviews/repository/{review,pull}.repo.ts` take their
row types from `db/rows.ts` or declare them locally, never from the parent facade.

**Fix:** move `MemoryRow`, `InsertMemory` and `NearestOptions` into a
`modules/memory/types.ts` (`repo-intel/types.ts` is the precedent) that both the facade
and the aggregate files import, so the dependency is one-directional.

### 13. The facade-over-aggregates split may be more structure than this module earns

`repository.ts` + `repository/item.repo.ts` + `repository/search.repo.ts` is three files
and a delegating class for **four functions over one table**. `guides/pitfalls-and-tradeoffs.md`
warns against exactly this: *"don't scaffold a facade-over-aggregates repository for a
module that will only ever need two queries"*, and contrasts `modules/settings/` (small,
no repository) with `modules/reviews/` (full facade over three genuinely distinct
aggregates and multiple tables).

The doc comment at `repository.ts:6-11` pre-argues the case ("they share a table but not a
reason to change"), and that argument is reasonable — vector-tuning churn really is
independent of schema churn. So this is a judgement call, not a defect. I would collapse
the two into `repository.ts` now and split when a second table or a real query set
arrives; if you keep the split, the argument in the comment is what justifies it and it
should stay there.

### 14. Small things

- `constants.ts:6` — `DEDUPE_NORMALISE` is named as if it were a normalizing function but
  is the whitespace pattern used by one. `WHITESPACE_RUN` (or similar) reads truer. It is
  also a `/g` regex exported as module state; safe with `String.replace` (which resets
  `lastIndex`), but a future `.test()` call on it would be intermittently wrong. A
  non-global regex or a `normalizeContent()` helper removes the footgun entirely.
- There is no write-time dedupe: `POST /memory` with the same sentence twice creates two
  rows and spends two embedding calls, and `helpers.ts` only hides that at read time.
  Worth considering a pre-insert lookup on normalized content, or bumping `updatedAt` on
  an existing match instead of inserting.
- `service.ts:45` defaults `limit` to `DEFAULT_SEARCH_LIMIT` even though `routes.ts:19`
  already applies the same default via Zod. Harmless and arguably right (the service is
  callable outside HTTP) — flagging only so it is a deliberate choice rather than an
  accident.
- No client-side consumer is included, though `service.ts:24-25` refers to "the panel that
  renders it". If the panel is a follow-up PR, say so in the description; if it was meant
  to be here, it is missing.

---

## What's correct (checked, no action needed)

Recording these so the layering review is not mistaken for silence:

- **Dependency Rule holds.** No file under `memory/` imports anything from
  `server/src/adapters/*`. External capability is reached only through the port:
  `service.ts:59` calls `await this.container.embedder()`, typed as the `Embedder`
  interface from `vendor/shared/adapters.ts:91`. The concrete `OpenAIEmbedder` is
  constructed only in `platform/container.ts:214`, the composition root — exactly the rule
  in `guides/layer-model.md`.
- **The port already existed**, so the "new external dependency → add a port first"
  checklist item is satisfied by construction; this module is the first consumer of
  `container.embedder()` and it consumes it correctly, including the documented
  degrade-on-ConfigError contract.
- **Routes are presentation-only.** `routes.ts` is Zod validation → `getContext` →
  one service call → response shaping, with no repository access, no adapter access and no
  domain branching. It matches `reviews/routes.ts` line for line in structure.
- **All Drizzle access lives in the repository layer.** `service.ts` and `routes.ts`
  never import `db/schema.js`; only `repository.ts` and `repository/*.repo.ts` do.
- **Workspace scoping is threaded correctly through the read paths.**
  `search.repo.ts:21` and `item.repo.ts:16` both filter on `workspaceId`. `markUsed`
  filters by id alone (`item.repo.ts:24`), which is safe here because the ids can only
  come from the workspace-scoped `nearest` query — worth a one-line comment saying so, but
  not a leak.
- **The pgvector interpolation is safe.** `search.repo.ts:14` looks like string
  concatenation but Drizzle's `sql` template binds `JSON.stringify(embedding)` as a
  parameter; it is not an injection vector.
- **`Container` injected whole into the service** (`service.ts:30`) and **row types
  doubling as DTOs** (`repository.ts:16`) are the two compromises
  `guides/pitfalls-and-tradeoffs.md` explicitly marks as intentional in this codebase.
  Not flagged. (Item 2 above is about shipping the row *over HTTP*, which is a separate
  concern from using it internally.)
- **Extra module files are conventional.** `constants.ts` and `helpers.ts` alongside
  `routes/service/repository` match `settings/` (`helpers.ts`, `feature-models.ts`) and
  `reviews/` (`helpers.ts`, `findings.ts`, `run-executor.ts`), so they are not the "ad hoc
  extra top-level files" the checklist warns about.
- **No `groundFindings` obligation here.** This module produces no diff-anchored findings,
  so the grounding gate does not apply.
- **The `memory` table already exists** (`db/schema/knowledge.ts:8`, shipped in
  `0000_init.sql:183`) and its columns match `InsertMemory`, so no table migration is
  needed — only the index in item 3.
