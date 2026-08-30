# PR review — new `server/src/modules/memory/`

Reviewed as if the fixture files were `server/src/modules/memory/{routes,service,repository,helpers,constants}.ts` plus `repository/{item,search}.repo.ts`, against the conventions in `server/CLAUDE.md`, `TESTING.md`, the existing sibling modules (`conventions/`, `risks/`, `reviews/`), `server/src/platform/container.ts`, and `server/src/db/schema/knowledge.ts`.

Verdict: **changes requested.** The layering is right and the module reads well, but it does not currently reach production (never registered), and there are four functional/behavioural bugs plus a set of tenancy and payload issues.

---

## Blocking

### 1. The module is never registered — every route 404s
**`routes.ts:32`** (and the missing edit to `server/src/modules/index.ts`)

`server/src/app.ts:192-195` registers plugins only from the static registry in `server/src/modules/index.ts`:

```ts
for (const plugin of Object.values(modules)) {
  await app.register(plugin);
}
```

`modules/index.ts` still lists 16 modules and none of them is `memory`. Its own header comment spells the requirement out: *"ADD A MODULE: create `modules/<name>/routes.ts` exporting a default Fastify plugin, then add one import + one entry below."* As shipped this whole PR is dead code — `POST /memory`, `GET /memory/search`, `DELETE /memory/:id` all return 404.

**Fix:** add `import memory from './memory/routes.js';` and a `memory,` entry to the `modules` record in `server/src/modules/index.ts`. (There is a matching client nav entry already waiting for it — `client/src/components/app-shell/helpers.ts:36`.)

---

### 2. `repoId` search filter silently drops every global and team memory
**`repository/search.repo.ts:23`**

```ts
opts.repoId ? eq(t.memory.repoId, opts.repoId) : undefined,
```

`memory.repoId` is nullable (`db/schema/knowledge.ts:15`) and `scope` is `'repo' | 'global' | 'team'` (line 16). A `global` or `team` memory is stored with `repo_id = NULL`. `eq(repoId, X)` is false for NULL rows, so a search made from a repo context returns **only** repo-scoped memories and silently hides exactly the cross-cutting memories the `global`/`team` scopes exist to provide. That defeats the point of having a scope column.

**Fix:** widen the predicate to `or(eq(t.memory.repoId, opts.repoId), isNull(t.memory.repoId))`, or filter on `scope` explicitly (`repoId` matches OR `scope in ('global','team')`). Whatever you choose, encode it in a comment — the semantics of "search within repo X" is a product decision worth stating.

---

### 3. `markUsed` is documented as best-effort but is awaited unguarded on the read path
**`repository/item.repo.ts:21` vs `service.ts:48`**

`item.repo.ts:21` states the contract:

```ts
/** Recency feeds ranking later; a failed touch must never fail the read. */
```

but the only caller does:

```ts
await this.repo.markUsed(rows.map((r) => r.id));   // service.ts:48
```

A dead connection, a lock timeout, or a read-only replica turns a successful search into a 500. The code contradicts its own stated invariant, and it does so on the module that `service.ts:22-25` explicitly says must not take the rest of the page down.

Secondary concern: this makes every search a read **plus** a write, so `GET /memory/search` can no longer be served from a replica or inside a read-only transaction.

**Fix:** make the call actually best-effort — e.g. `void this.repo.markUsed(ids).catch((e) => { /* log */ });` — or wrap it in try/catch inside the service. If it is meant to block, delete the comment instead so the contract is honest.

---

### 4. Every response ships the raw 1536-float embedding
**`repository/search.repo.ts:16` (`.select()`), `routes.ts:40` and `routes.ts:46`, `service.ts:36`**

`nearest` does an unqualified `db.select()`, and both routes return `MemoryRow` straight to the client. `MemoryRow` includes `embedding: number[] | null` at 1536 dimensions (`db/schema/knowledge.ts:21`). At the default limit of 8 that is ~12k floats serialised as JSON — on the order of 200 KB of response body per search, for a vector no client can use. `POST /memory` returns it too.

There is an established pattern for this in the neighbouring module: `conventions/helpers.ts` exposes `toConventionDto` and the service returns DTOs, not rows.

**Fix:** select an explicit column list in `search.repo.ts` (drop `embedding`), and add a `toMemoryDto` to `helpers.ts` that the service applies on both the write and read paths. That also stops the internal column set leaking into the public API shape.

---

## Should fix before merge

### 5. `repoId` is accepted from the request without any workspace-ownership check
**`routes.ts:13` and `routes.ts:18`, consumed at `service.ts:36` and `service.ts:44`**

Zod validates only that `repoId` is a uuid. Nothing checks that the repo belongs to the caller's workspace before it is written into a `memory` row or used as a search filter. Both sibling modules do check:

- `risks/service.ts:24` — `if (!(await this.repo.prExists(workspaceId, prId))) throw new NotFoundError(...)`
- `conventions/service.ts:116` — `const repo = await this.repo.getRepo(workspaceId, repoId);`

Today this is a cross-workspace write (a memory row attached to another tenant's repo) rather than a read leak, because the search side is also workspace-scoped. In the single-workspace MVP that is theoretical, but the tenancy rule in `db/schema.ts:5-7` is absolute, and this is the kind of thing that becomes a real vulnerability the moment auth stops being `LocalNoAuthProvider`.

**Fix:** add a `repoExists(workspaceId, repoId)` to `item.repo.ts`, call it from `MemoryService.remember` (and from `search` when `repoId` is present), and throw `NotFoundError`/`ValidationError` on miss.

### 6. `scope` and `repoId` are never cross-validated
**`routes.ts:9-14`**

`RememberBody` accepts `{ scope: 'repo' }` with no `repoId`, and `{ scope: 'global', repoId: '<uuid>' }`. The first produces a repo-scoped row that no repo-filtered search can ever match (unreachable data); the second produces a contradictory row. Nothing downstream rejects either.

**Fix:** `RememberBody.superRefine(...)` — require `repoId` when `scope === 'repo'`, forbid it otherwise. Zod validation at the edge is the stated convention (`server/CLAUDE.md`, "Routes validate via Zod `params`/`body` schemas ... before the handler runs").

### 7. De-duplication happens after `LIMIT`, so pages come back short
**`service.ts:43-49`**

The SQL `LIMIT` is applied first, then `dedupeByContent` removes rows from the already-truncated set. A caller asking for `limit=8` can get 3 back, with no indication that more matches exist — and `helpers.ts:9-13` says near-duplicates are *common*, so this will be the normal case, not the edge. Related: `markUsed` (line 48) touches `lastUsedAt` on rows that are then discarded by the dedupe on line 49, polluting the recency signal the comment says will feed ranking.

**Fix:** over-fetch (`limit * 3`, capped by a constant), dedupe, then `slice(0, limit)`; and move `markUsed` after the dedupe so only returned rows are touched. Alternatively push dedupe into SQL with `DISTINCT ON` over a normalised content expression.

### 8. `markUsed` is not workspace-scoped
**`repository/item.repo.ts:22-25`**

```ts
await db.update(t.memory).set({ lastUsedAt: new Date() }).where(inArray(t.memory.id, ids));
```

No `workspace_id` predicate. It is not exploitable as written because the ids come from a workspace-scoped `nearest`, but `db/schema.ts:5-7` states the rule without exception — *"All queries scope by workspace_id"* — and the sibling `reviews/repository/pull.repo.ts` follows it even for id lookups. A future caller passing ids from anywhere else inherits a silent cross-tenant write.

**Fix:** take `workspaceId` as a parameter and `and(eq(t.memory.workspaceId, workspaceId), inArray(t.memory.id, ids))`.

### 9. No relevance floor — search always returns k results, however unrelated
**`repository/search.repo.ts:26-27`**

The query orders by cosine distance and takes `limit` with no distance cutoff and without returning the score. A query with nothing relevant in the store still returns 8 items, and the caller has no way to tell a strong match from noise. For a memory panel injected into review context, that is worse than returning nothing.

**Fix:** add a `MAX_MEMORY_DISTANCE` to `constants.ts` (alongside `DEFAULT_SEARCH_LIMIT`), filter on it, and select the distance as a `score` column so the UI and any future ranking pass can use it.

### 10. Circular import between `repository.ts` and its `repository/*.repo.ts` children
**`repository/item.repo.ts:4` and `repository/search.repo.ts:4`**

Both leaf files do `import type { InsertMemory, MemoryRow } from '../repository.js';` while `repository.ts:13-14` imports them. It is type-only so it is erased at emit and won't break at runtime — but the identical precedent in `reviews/` deliberately avoids it: `reviews/repository/pull.repo.ts:4` imports its row types from `db/rows.ts`, whose docstring (`db/rows.ts:5-10`) explains that row types live next to the schema *"so cross-cutting consumers can reference a row shape WITHOUT importing another module's data layer"*.

**Fix:** move `MemoryRow` into `db/rows.ts` (and re-export it from `repository.ts` as `reviews/repository.ts:17-18` does), and move `InsertMemory` / `NearestOptions` down into the leaf files, or into a small `repository/types.ts`.

### 11. No tests at all
**whole PR**

`TESTING.md` calls for *"one real integration per data-backed workflow, against a real Postgres"*, and this is a data-backed workflow whose logic lives in SQL (vector distance, the NULL-repoId filter in #2, workspace scoping). Server tests live in `server/test/`, not beside the module.

**Fix:** add
- `server/test/memory.it.test.ts` — remember → search → forget over a real Postgres via the existing testcontainers harness, with `ContainerOverrides.embedder` supplying a deterministic vector (`adapters/mocks.ts:109` already returns a 1536-dim vector). Cover the `scope: 'global'` + `repoId` filter case from #2 and the 404 from `forget`.
- `server/test/memory-helpers.test.ts` — a unit test for `dedupeByContent` (matches the existing `risks-helpers.test.ts` / `brief-helpers.test.ts` naming).

Note the naming gotcha in `server/CLAUDE.md`: a DB-backed test **must** end in `.it.test.ts` or the unit/integration split miscategorises it.

### 12. An item embedded while embeddings are off is invisible forever, with no backfill and no signal
**`service.ts:34-37`, `service.ts:57-65`**

`embedOrNull` swallows the `ConfigError` thrown by `container.embedder()` when `EMBEDDINGS_ENABLED=false` (`platform/container.ts:209-211`), stores the row with `embedding: null`, and returns 201. `nearest` filters `isNotNull(embedding)` (`search.repo.ts:22`), so that row can never be found again. The degradation is deliberate and documented (`service.ts:22-25`), but there is no re-embed path and the API gives the caller no hint that what they just saved is unsearchable.

**Fix:** at minimum return an `embedded: boolean` on the write response so the UI can warn; ideally add a small backfill (a `nullEmbeddings(workspaceId)` query plus a re-embed call) so turning embeddings on later recovers the backlog. Worth a line in the module docstring either way.

---

## Minor / nits

13. **`repository/` split is premature here.** `reviews/` sets the precedent, but it splits ~500 lines across four aggregates. `memory` splits four one-line functions across two files and then needs a pure pass-through class (`repository.ts:32-50`) to reassemble them. `conventions/`, `risks/`, `context/`, `brief/` all keep a single `repository.ts`. Not blocking — but a flat `repository.ts` would be less indirection for the same result, and the module can split later when it earns it.

14. **Bare `catch {}` with no logging** — `service.ts:62`. A real OpenAI outage, a dimension mismatch, and "embeddings disabled" are indistinguishable in the logs, and search just silently returns `[]`. Sibling modules thread a logger from the route for exactly this reason (`conventions/routes.ts:34`, and `conventions/service.ts` `ExtractLogger`). Log at warn/debug before swallowing.

15. **The `scope` / `kind` unions are written out three times** — `routes.ts:10-11`, `service.ts:8-9`, `repository.ts:21-22` — and a fourth time in `db/schema/knowledge.ts:16-19`. They will drift. `conventions/routes.ts:4` imports `ConventionStatus` from `@devdigest/shared`; do the same, or derive from the Zod schema with `z.infer` and reuse it in the service/repository types.

16. **Hand-rolled vector SQL** — `search.repo.ts:14`. `JSON.stringify(embedding)::vector` does work (drizzle binds it as a parameter, and Postgres allows the explicit text→vector I/O cast), but the schema already uses drizzle's `vector()` column type (`knowledge.ts:21`), so `cosineDistance(t.memory.embedding, embedding)` from `drizzle-orm` is the typed, less brittle equivalent. This is the repo's first vector query, so whatever you pick becomes the house pattern — worth getting right now.

17. **No dimension check.** `Embedder.dims` exists (`src/vendor/shared/adapters.ts:94`) and the column is `vector(1536)`. If a differently-sized embedder is ever configured, `insertItem` fails with a raw Postgres error surfacing as a 500. A `vector.length !== embedder.dims` guard in `embedOrNull` turning it into a `ConfigError` would be cheap.

18. **No ANN index on `memory.embedding`.** `0000_init.sql:407` creates only `memory_ws_idx` (btree on `workspace_id`); there is no ivfflat/hnsw index anywhere in the migrations. Every search is a sequential scan over the workspace's rows. Fine at local-first scale and it needs its own migration, so out of scope for this PR — but this PR is what makes it matter, so it deserves a TODO or a follow-up issue rather than silence.

19. **Redundant default.** `DEFAULT_SEARCH_LIMIT` is applied twice — `routes.ts:19` (Zod `.default`) and `service.ts:45` (`?? DEFAULT_SEARCH_LIMIT`). Harmless, and defensible as service-level safety for non-HTTP callers; just noting it.

---

## Checked and clean

Worth saying explicitly, because these are the things that usually go wrong in a new module here:

- **Layering.** `routes → service → repository` with no shortcuts: routes never touch `db`, the service never imports `drizzle-orm`, and the repository is the only layer touching `t.memory`. Matches `server/CLAUDE.md`'s map.
- **Wiring.** `new MemoryService(app.container)` in the route and `new MemoryRepository(container.db)` in the service constructor is exactly what all eleven existing modules do (`risks/service.ts:20`, `conventions/service.ts:87`, …). No adapter is constructed outside `platform/container.ts`.
- **Ports, not vendors.** The embedder is resolved through `container.embedder()` — no direct OpenAI import — and wrapped in try/catch precisely as `platform/container.ts:205-207` instructs callers to do.
- **Tenancy at the edge.** Every handler calls `getContext` and threads `workspaceId` into the service; `insertItem`, `deleteItem` and `nearest` are all workspace-scoped (`markUsed` is the sole exception, #8).
- **Validation.** Zod `body`/`querystring`/`params` schemas on all three routes, reusing the shared `IdParams` — no hand-rolled `Schema.parse(req.body)`, which is the documented non-default convention.
- **Errors.** `NotFoundError` from `platform/errors.js`, giving the standard 404 envelope; `201` on create and `{ ok: true }` on delete both match `agents/routes.ts:141` and `reviews/routes.ts:117`.
- **Schema.** No migration added, correctly — `memory` already exists in `db/schema/knowledge.ts` / `0000_init.sql:183`, and the "don't delete an unused future-lesson table" rule is respected. The `InsertMemory` shape matches the columns.
- **File layout.** `constants.ts` + a pure, I/O-free `helpers.ts` matches `risks/`, `brief/`, `conventions/`, `context/`.
- **Comments.** The docstrings explain *why* (degrade-don't-throw, dedupe rationale, the split-repository rationale) rather than restating the code — house style. The one problem is that `item.repo.ts:21` promises behaviour the caller doesn't deliver (#3).
