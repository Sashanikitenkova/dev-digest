# PR Review — new `memory` module (`server/src/modules/memory/`)

Reviewed files (as they would land under `server/src/modules/memory/`):
`constants.ts`, `helpers.ts`, `routes.ts`, `service.ts`, `repository.ts`,
`repository/item.repo.ts`, `repository/search.repo.ts`.

**Verdict: request changes.** The layering is right (routes → service →
repository, `Container` injected, no adapter constructed outside
`platform/container.ts`, `getContext` used on every handler) and the comments
are unusually good. But there are five blocking problems: the module is never
registered, the search's `repoId` filter silently hides every global/team
memory, raw DB rows (including the 1536-float embedding) go straight onto the
wire, a bookkeeping write can fail the read it was explicitly documented not to
fail, and `repoId` crosses the tenancy boundary unchecked.

---

## Blocking

### 1. The module is never registered — every route in this PR is dead code
**File:** `routes.ts:32` (and the absent change to `server/src/modules/index.ts`)

`memoryRoutes` is exported as a default Fastify plugin, but the PR contains no
change to `server/src/modules/index.ts`, which is the single static registry:

```ts
export const modules: Record<string, FastifyPluginAsync> = {
  settings, repos, pulls, polling, workspace, agents, skills, reviews,
  repoIntel, conventions, context, intent, blast, brief, risks, smartDiff,
};
```

`memory` is not in it. `POST /memory`, `GET /memory/search` and
`DELETE /memory/:id` all 404 as merged. That file's own comment spells out the
contract ("ADD A MODULE: create `modules/<name>/routes.ts` … then add one
import + one entry below") and names `memory` as a future lesson module.

**Fix:** add `import memory from './memory/routes.js';` and a `memory,` entry to
`modules/index.ts`. Add a smoke assertion in `test/routes-smoke.test.ts` so a
missing registration fails a test rather than shipping.

---

### 2. Repo-scoped search can never return a `global` or `team` memory
**File:** `repository/search.repo.ts:23`

```ts
opts.repoId ? eq(t.memory.repoId, opts.repoId) : undefined,
```

`db/schema/knowledge.ts:15` declares `repoId` nullable, and `scope` allows
`'global'` and `'team'` — those rows are stored with `repo_id IS NULL` by
design. `eq(repoId, X)` is false for NULL in SQL, so as soon as the caller
passes a `repoId` (which the UI will, on any repo/PR page — that is the whole
point of the parameter) the query drops every global and team memory. The one
call path where those items *are* returned is the one where the user gave no
repo context at all. That inverts the intended behaviour: workspace-wide
knowledge should be visible everywhere, repo knowledge only in its repo.

**Fix:**

```ts
import { or, isNull } from 'drizzle-orm';
...
opts.repoId ? or(eq(t.memory.repoId, opts.repoId), isNull(t.memory.repoId)) : undefined,
```

and add an integration test asserting that a `global` item is returned by a
search that passes a `repoId`.

---

### 3. Raw Drizzle rows are returned to HTTP clients, embedding vector included
**Files:** `routes.ts:38`, `routes.ts:46`; `repository/search.repo.ts:16`
(`db.select()` with no column list); `service.ts:34,39` (`Promise<MemoryRow>`)

`MemoryRow` is `typeof t.memory.$inferSelect`, i.e. every column — including
`embedding`, a 1536-element `vector`. `service.remember` returns that row and
the route returns it verbatim; `search` returns an array of them. A default
search (limit 8) therefore serialises roughly 12,000 floats — on the order of
100 KB of JSON — to render eight sentences. It also puts `confidence`,
`sources`, `updatedAt` and `lastUsedAt` on the wire as internal camelCase
column names.

This also breaks the module's own contract, which already exists:
`server/src/vendor/shared/contracts/knowledge.ts:105` defines `MemoryItem`
(`content`, `scope`, `kind`, `confidence`, `sources`). Every sibling module
maps rows to a shared contract before returning — e.g.
`conventions/helpers.ts:119` `toConventionDto(row): ConventionCandidate`, and
`risks/routes.ts:20` annotates the handler's return as the shared `Risks` type.
Memory is the only module that skips this, so the client would have to be
written against the DB schema.

**Fix:** add `toMemoryDto(row: MemoryRow): MemoryItem` to `helpers.ts`, have the
service return `MemoryItem[]`, annotate the route handlers with the shared type,
and select explicit columns in `search.repo.ts` (drop `embedding` from the
projection — nothing downstream reads it). Consider extending the shared
contract with `id` and `created_at`, which `DELETE /memory/:id` needs and
`MemoryItem` currently lacks.

---

### 4. A failed `markUsed` fails the search — contradicting its own comment
**Files:** `repository/item.repo.ts:21-24`, `service.ts:48`

`item.repo.ts:21` states the intent plainly:

> `/** Recency feeds ranking later; a failed touch must never fail the read. */`

But the caller awaits it unguarded, before returning:

```ts
await this.repo.markUsed(rows.map((r) => r.id));   // service.ts:48
return dedupeByContent(rows);
```

Any error from that `UPDATE` — lock contention, a dropped connection, a
read-only replica — rejects `search()` and 500s the endpoint, even though the
rows were already fetched successfully. That directly defeats the degradation
story the class docblock sells at `service.ts:22-25` ("search degrades to
returning nothing rather than throwing — the panel … must not take the others
down with it").

Two related problems on the same line:

- **`markUsed` is not workspace-scoped** (`item.repo.ts:24`:
  `.where(inArray(t.memory.id, ids))`). `db/schema.ts:5` states the rule: "All
  queries scope by workspace_id". It is safe today only because the ids happen
  to come from a workspace-scoped select; that is an invariant held by a
  caller, not by the query. Add `eq(t.memory.workspaceId, workspaceId)`.
- **Rows are marked used before dedupe** (`service.ts:48` then `:49`).
  Near-duplicates that the user never sees get their `lastUsedAt` bumped,
  which will skew the recency ranking the comment says this feeds. Dedupe
  first, then touch only the surviving ids.

**Fix:**

```ts
const items = dedupeByContent(rows);
void this.repo.markUsed(workspaceId, items.map((r) => r.id))
  .catch((err) => this.container.log?.warn({ err }, 'memory: markUsed failed'));
return items;
```

(or keep the `await` inside a `try/catch` — the point is that it must not
propagate).

---

### 5. `repoId` crosses the tenancy boundary unchecked
**Files:** `routes.ts:13`, `service.ts:36`

`RememberBody.repoId` is validated as a uuid and then passed straight through
to the insert. Nothing checks that the repo belongs to the caller's workspace.
The FK at `db/schema/knowledge.ts:15` only proves the repo *exists*, in *any*
workspace — so a client can attach a memory item to another tenant's repo id.
Local no-auth MVP makes this low-severity today, but the house pattern already
exists specifically to prevent it: `conventions/repository.ts:32`
`getRepo(workspaceId, repoId)` followed by a `NotFoundError` in the service.

Same handler, second gap: `scope: 'repo'` with no `repoId` is accepted. The
resulting row has `repo_id IS NULL` and can never be reached by a repo-scoped
search, so the write silently succeeds and the memory is unreachable.

**Fix:** in `MemoryService.remember`, when `input.repoId` is present, resolve it
workspace-scoped and throw `NotFoundError('Repo not found')` otherwise. Tighten
the body schema with a Zod refinement (or a discriminated union) so
`scope: 'repo'` requires `repoId` and `scope: 'global' | 'team'` forbids it,
returning a clean 422 rather than an unreachable row.

---

## Should fix before merge

### 6. `scope`/`kind` unions are hand-copied in four places
**Files:** `routes.ts:10-11`, `service.ts:8-9`, `repository.ts:21-22`, against
`db/schema/knowledge.ts:16-19`

`MemoryScope` and `MemoryKind` are already defined once, as Zod enums, in
`vendor/shared/contracts/knowledge.ts:87-97`. The PR re-declares both literal
unions three more times. Adding a sixth `kind` means editing four files, and
missing one is a type error at best and a DB constraint violation at worst.

**Fix:** `import { MemoryScope, MemoryKind } from '@devdigest/shared'` — use the
Zod schemas directly in `RememberBody`, and `z.infer` types (or the exported
type aliases) in `RememberInput` and `InsertMemory`.

### 7. Dedupe runs after `LIMIT`, so `limit` is not honoured
**Files:** `service.ts:43-49`, `repository/search.repo.ts:27`

The SQL takes `LIMIT 8`, then `dedupeByContent` removes rows in memory. With
the exact near-duplicates the helper's own comment says are common ("the same
decision gets remembered from several PRs"), a `limit=8` request routinely
returns three or four items while more distinct matches sat just past the
cutoff. There is no way for the caller to page past it either.

**Fix:** over-fetch (e.g. `limit * 3`, capped) in the repository, dedupe, then
`slice(0, limit)` in the service.

### 8. Items stored with a null embedding are permanently invisible, and nothing
says so
**Files:** `service.ts:35-36`, `repository/search.repo.ts:22`

`remember` stores the item with `embedding: null` when the embedder is
unavailable, and returns 201. `nearest` filters `isNotNull(t.memory.embedding)`.
So those rows are never retrievable — not "degraded", permanently dark — and
there is no backfill path in the PR. The service docblock's "nothing is lost"
(`service.ts:23`) is true of the bytes and false of the feature. A user who
writes ten memories before configuring a key gets ten dead rows and a 201 each
time.

**Fix:** at minimum, add a re-embed path (a job, or lazily on next search) and
have the response indicate `embedded: false` so the UI can say "saved, not yet
searchable". Alternatively reject the write with a `ConfigError` when
embeddings are disabled — but the degrade-and-backfill option is better and
matches the module's stated intent.

### 9. `embedOrNull` swallows every error with no signal
**File:** `service.ts:57-65`

```ts
} catch {
  return null;
}
```

A deliberate `ConfigError('Embeddings are disabled …')` from
`platform/container.ts:210`, an expired `OPENAI_API_KEY`, a 429, and a network
timeout are all flattened to "search returns nothing". Nothing is logged, so
"memory search is empty" is undebuggable from the server logs.

**Fix:** catch, log at `warn` with the error (`req.log` / the app logger), and
distinguish `ConfigError` (expected, quiet) from everything else (unexpected,
noisy). Surfacing a `reason` on the search response would let the panel say
"embeddings not configured" instead of rendering an empty state that looks like
"you have no memories".

### 10. No index backs the vector search
**File:** `repository/search.repo.ts:26` (`.orderBy(distance)`); schema at
`db/schema/knowledge.ts:28`

`memory` carries only `memory_ws_idx` on `workspace_id`. There is no ivfflat or
hnsw index anywhere in `src/db/migrations/` (grepped: zero hits for
`ivfflat`/`hnsw`/`vector_cosine`). Every search is a sequential scan of the
workspace's memories with a full distance sort. It will be fine at 100 rows and
will not be at 100,000 — and this is the module whose whole read path is that
query.

**Fix:** add a migration creating
`CREATE INDEX memory_embedding_idx ON memory USING hnsw (embedding vector_cosine_ops);`
(matching the `<=>` operator this code uses). Note `pnpm db:migrate` is manual
here — migrations are not applied on boot.

### 11. No tests
The PR adds none. `server/test/` holds ~40 suites, including per-module helper
unit tests (`risks-helpers.test.ts`, `brief-helpers.test.ts`,
`intent-helpers.test.ts`) and per-module DB tests (`context.it.test.ts`,
`skills.it.test.ts`).

**Fix:** add `test/memory-helpers.test.ts` for `dedupeByContent` (whitespace and
case folding, order preservation, empty input) and `test/memory.it.test.ts` for
the round trip — remember → search → forget, the global/global-vs-repo scoping
in finding 2, and 404 on forgetting an unknown id. A DB-backed test **must** be
named `*.it.test.ts` or the unit/integration split miscategorises it silently.

### 12. `repository/` subfolder diverges from the documented module shape
**Files:** `repository.ts:13-14`, `repository/item.repo.ts`,
`repository/search.repo.ts`

`server/CLAUDE.md` documents the map as
`modules/<name>/{routes,service,repository}.ts`, and all sixteen existing
modules are flat. The composed class here is 50 lines wrapping two files that
total 50 more; the split buys a delegation layer that has to be kept in sync by
hand (four pass-through methods) for a table with four queries. The rationale in
the docblock ("they share a table but not a reason to change") is reasonable in
principle but is not yet earning its cost at this size, and it introduces a
one-off structure a reader of any other module will not expect.

**Fix:** collapse into a single `repository.ts`. If the split is kept
deliberately, note that `item.repo.ts:4` and `search.repo.ts:4` import back from
the parent `repository.ts` — a module cycle that is only harmless because both
are `import type` and get erased. One future value import (a constant, a helper)
turns it into a real runtime cycle with a confusing failure mode. Move
`InsertMemory` / `NearestOptions` / `MemoryRow` into a `types.ts` that both
sides import if the folder stays.

---

## Minor

- **`repository/search.repo.ts:14`** — the raw
  `sql\`${embedding} <=> ${JSON.stringify(...)}::vector\`` is hand-rolling
  something the ORM provides: drizzle-orm 0.38 (pinned in `server/package.json`)
  exports `cosineDistance` (verified present alongside `l2Distance`,
  `innerProduct`). Use
  `cosineDistance(t.memory.embedding, embedding)` — it is typed, and it removes
  the manual `JSON.stringify` + cast. (The current form is not an injection
  risk: drizzle binds the interpolated string as a parameter.)
- **`service.ts:45` vs `routes.ts:19`** — the default limit is applied twice
  (Zod `.default(DEFAULT_SEARCH_LIMIT)` and `opts.limit ?? DEFAULT_SEARCH_LIMIT`).
  Harmless, but it means `limit` is never actually undefined at the service and
  the second default is untestable through the route. Keep the service-side one
  (it guards direct callers) and drop the redundancy from the type by making
  `NearestOptions.limit` required, as it already is.
- **`constants.ts:6`** — `DEDUPE_NORMALISE` is a module-level regex with the `g`
  flag. Safe with `.replace` as used at `helpers.ts:18`, but a shared `/g` regex
  is a stateful-`lastIndex` footgun the moment someone reaches for `.test()` or
  `.exec()` on it. Also the name describes an action, not what it matches —
  `WHITESPACE_RUN` reads truer.
- **`service.ts:60`** — no check that the returned vector's length matches
  `embedder.dims` (1536, the column's declared dimension). A misconfigured or
  swapped embedder produces an opaque Postgres error at insert time rather than
  a clear message at the boundary.
- **`repository/search.repo.ts`** — the distance is computed for ordering but
  never returned. The client cannot threshold on relevance or explain why an
  item ranked where it did, and there is no floor on how bad a "nearest" match
  may be: with three items in the table, a search for anything returns all
  three. Consider selecting the distance as a `score` and applying a maximum
  distance.
- **`routes.ts:24-26`** — the docblock lists three routes but the module has no
  list/browse endpoint. Fine if the panel is search-only; worth confirming the
  UI does not need `GET /memory`.
