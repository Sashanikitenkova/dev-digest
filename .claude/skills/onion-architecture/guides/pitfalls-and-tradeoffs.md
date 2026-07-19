# Pitfalls & Trade-offs

Onion architecture is a tool for managing complexity in a growing codebase — it is not free, and applying it uniformly to every file is itself a mistake. This guide covers when to hold back, and which of DevDigest's own deviations from strict onion purity are intentional.

## When not to add a new layer or port

A one-off script or a module with a single trivial query doesn't need a full port+adapter split. Research consistently warns against this (see `references.md` §5, especially Three Dots Labs' "Is Clean Architecture Overengineering?", included deliberately as a dissenting/cautionary voice so this skill doesn't read as dogmatic).

In this repo, compare `server/src/modules/settings/` (no `repository.ts` — `routes.ts` + `feature-models.ts` + `helpers.ts`, proportionate to a small, low-complexity domain) against `server/src/modules/reviews/` (full `routes.ts`/`service.ts`/facade-`repository.ts`-over-three-aggregates, proportionate to a domain with real orchestration and multiple persisted entities). Match a new module's layering depth to its actual complexity — don't scaffold a facade-over-aggregates repository for a module that will only ever need two queries.

## Anemic domain models / DTO dilution

A common failure mode elsewhere (not currently a problem in this repo, but worth guarding against as it grows): domain "entities" that are just bags of data with all behavior pushed into services, and DTOs reused across unrelated use cases so a change to one flow's shape breaks an unrelated one. DevDigest's row types (`server/src/db/rows.ts`) are schema-shaped DTOs by design — see `guides/drizzle-repository-pattern.md` — which is an accepted trade-off here, not evidence of an anemic domain; the actual business logic (grounding, prompt assembly, run orchestration) lives in `reviewer-core` and each module's `service.ts`, not in the row types.

## This skill is descriptive, not aspirational, in a few places

Two specific deviations from strict onion purity are deliberate, documented conventions in this codebase — don't flag either as a bug during a review unless it's actually causing a concrete testability problem:

- **`service.ts` files depend on the whole `Container`, not narrowly-scoped injected ports.** `ReviewService`'s constructor takes `container: Container` rather than, say, individual `git: GitClient, github: GitHubClient` parameters. Interface segregation isn't fully enforced at the service-constructor level. This is an accepted convenience trade-off (fewer constructor parameters to thread through as services grow) rather than an oversight — the port-level segregation still happens one level down, inside `Container`'s own typed getters/methods and `ContainerOverrides`.
- **Row types (`db/rows.ts`) double as DTOs.** As covered above — accepted so cross-cutting consumers can share row shapes without importing another module's data layer, at the cost of domain types being schema-shaped rather than hand-modeled.

If a change genuinely needs narrower dependency injection (e.g. a service that must be constructed without ever touching `Container`, for a context where most of `Container` is unavailable), that's a legitimate reason to introduce narrower injection for that one service — but it's an intentional escalation, not a default expectation from this skill.
