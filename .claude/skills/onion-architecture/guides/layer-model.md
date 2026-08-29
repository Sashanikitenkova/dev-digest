# Layer Model

## The Dependency Rule

Source-code dependencies point inward only. The domain core doesn't know infrastructure exists; infrastructure knows about the domain (it implements interfaces the domain/application layer defines). Concretely, in `server/`:

- `server/src/vendor/shared/adapters.ts` is the boundary — it declares the port interfaces (`LLMProvider`, `Embedder`, `GitHubClient`, `GitClient`, `CodeIndex`, `AuthProvider`, `SecretsProvider`). Its own doc comment states the rule directly: "Adapter interfaces. ALL external calls go behind these interfaces... Services depend on the interface, not the impl."
- `server/src/platform/container.ts` is the **composition root** — the one place allowed to import concrete adapter classes (`OctokitGitHubClient`, `SimpleGitClient`, `OpenRouterProvider`, etc.) and wire them to the port types. Its doc comment: "Tests construct a container with `overrides` to inject mock adapters; the Services depend on these interfaces, not the concrete classes."
- Everything else — `modules/*/service.ts`, `modules/*/repository.ts`, `modules/*/routes.ts` — depends on `Container`'s port-typed members (`container.git`, `await container.github()`, `await container.llm('openrouter')`), never on a concrete adapter import.

If you find yourself importing from `server/src/adapters/*` anywhere outside `container.ts`, that's a Dependency Rule violation — stop and route it through the container instead.

## Package-level ring inversion (`reviewer-core`)

Within a single module, "inner" and "outer" map onto files. `reviewer-core` inverts this: the **entire `server/` package is "outside" from `reviewer-core`'s point of view**. `reviewer-core/src/index.ts`'s doc comment says it plainly:

> "Pure review logic shared by the server (local reviews in the studio) and the agent-runner (CI). NO database, GitHub, or filesystem access; the only side effect is an LLM call through an INJECTED LLMProvider."

So `reviewer-core` is itself an inner ring, packaged as a library and consumed by **two separate composition roots**: `server/src/platform/container.ts` (studio) and a CI agent-runner that "runs reviewer-core directly" (per `reviewer-core/src/llm/openrouter.ts`'s doc comment). Neither consumer's composition root is "the" root for `reviewer-core` — there are two, and `reviewer-core` itself must stay agnostic to both. Don't apply the single-composition-root mental model from `server/` when reasoning about `reviewer-core`'s boundaries.

## Onion vs Hexagonal vs Clean vs N-Tier, briefly

These names largely describe the same underlying structure. Per Microsoft's architecture guidance (the strongest single authority found in research — see `references.md` §2): "This architecture has gone by many names over the years... first names was Hexagonal Architecture, followed by Ports-and-Adapters. More recently, it's been cited as the Onion Architecture or Clean Architecture." All of them: (1) put business logic at the center with zero framework/infrastructure dependency, (2) define ports as domain/application-owned interfaces, (3) push infrastructure and UI to the edges, (4) invert the traditional N-Tier flow where business logic depends on data-access implementation details. DevDigest calls this "onion" for consistency with Palermo's original terminology (see `references.md` §1) — don't get hung up on which exact label applies to a given file; the Dependency Rule is what's enforced.

## Facades are an intra-ring pattern, not a ring boundary

Two facades exist in this codebase and neither is a port/adapter boundary — both are aggregate-composition conveniences *within* a single ring:

- `server/src/modules/reviews/repository.ts` — a class facade over `repository/{review,run,pull}.repo.ts` (plain functions doing raw Drizzle queries, one file per aggregate). Its own doc comment: "The query implementations are colocated, split by aggregate, under `./repository/`... This class composes them so its public API stays identical." This is entirely inside the data-access ring — don't confuse it with the ports/adapters split.
- `server/src/modules/repo-intel/service.ts` — a facade over `pipeline/*` internals. Its README states: "Everything downstream reads through one facade (`service.ts`) so consumers never touch the pipeline internals," and documents a "degrade gracefully" convention (an unindexed repo returns empty results rather than throwing) as part of that facade's contract.

When a domain module grows multiple aggregates, prefer this facade-over-`<aggregate>.repo.ts` split over either (a) one unsplit mega-file or (b) callers reaching past the facade into the aggregate-specific files directly.
