# Drizzle Repository Pattern

This covers layer boundaries around the data-access layer — not Drizzle query/schema syntax (see `drizzle-orm-patterns` for that).

## Repository owns all Drizzle access for its domain

`server/src/modules/reviews/repository.ts` states this as an explicit invariant in its own doc comment:

> "A2 — review data-access. The ONLY layer touching the DB for the review domain. Owns `reviews`, `findings`, `pr_intent`, and persists the observability rows `agent_runs` + `run_traces`."

No `service.ts` or `routes.ts` file imports `db/schema.js` or builds a `db.select()`/`db.insert()` query directly — they call typed methods on the module's `repository.ts` (or the shared `container.agentsRepo` / `container.reviewRepo` for cross-cutting entities).

## Facade-over-aggregate split for larger domains

When a domain module covers multiple aggregates, split the raw query implementations into `repository/<aggregate>.repo.ts` files (plain exported functions), and compose them behind one class that keeps a stable public API. `reviews/repository.ts` does exactly this over `repository/{review,run,pull}.repo.ts`:

```ts
import * as reviewRepo from './repository/review.repo.js';
import * as runRepo from './repository/run.repo.js';
import * as pullRepo from './repository/pull.repo.js';

export class ReviewRepository {
  constructor(private db: Db) {}
  getPull(workspaceId: string, prId: string) { return pullRepo.getPull(this.db, workspaceId, prId); }
  insertReview(values: {...}) { return reviewRepo.insertReview(this.db, values); }
  ...
}
```

`repo-intel`'s `service.ts`-over-`pipeline/*` split follows the same shape for a different kind of internal complexity (a multi-stage indexing pipeline instead of multiple DB aggregates).

## Row types are DTOs, not domain objects — an accepted compromise

`server/src/db/rows.ts` re-exports `$inferSelect` row types (`FindingRow`, `PullRow`, `AgentRow`, ...) so cross-cutting consumers can reference a row shape without importing another module's data layer:

> "They live here — next to the schema — rather than inside a module's `repository.ts`, so cross-cutting consumers (ci, eval, performance, conformance, compose, hooks, runs, reviews) can reference a row shape WITHOUT importing another module's data layer."

These row types are Drizzle-schema-shaped, not hand-modeled domain entities — this is a known friction point of schema-first ORMs like Drizzle (versus a codegen-based ORM like Prisma, where the generated client is already one layer removed from the physical schema; see `references.md` §4, Drizzle subsection). Treat this as a deliberate, documented compromise in this codebase, not something to "fix" by introducing a parallel domain-entity layer — see `guides/pitfalls-and-tradeoffs.md`.

## Good vs bad

**1 — who touches Drizzle**

- Good: `reviews/service.ts` calling `this.repo.getPull(workspaceId, prId)` — it never imports `db/schema.js` itself.
- Bad: a service or route file with `import * as t from '../../db/schema.js'` and its own `db.select().from(t.pullRequests).where(...)` inline. This duplicates query logic outside `repository.ts` and breaks the "ONLY layer touching the DB" invariant stated in `reviews/repository.ts`'s own doc comment.

**2 — growing a repository beyond one aggregate**

- Good: `reviews/repository.ts`'s facade-over-`repository/{review,run,pull}.repo.ts` split — one class with a stable public API, composed from focused per-aggregate files. Mirrors `repo-intel`'s facade pattern.
- Bad: either extreme — a single unsplit multi-hundred-line `repository.ts` mixing every aggregate's queries with no organization, **or** the inverse mistake of a caller importing `repository/review.repo.ts`'s functions directly instead of going through the `ReviewRepository` facade class, which defeats the point of having a stable composed API.
