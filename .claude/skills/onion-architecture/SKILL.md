---
name: onion-architecture
description: Guides and enforces onion/hexagonal layering across DevDigest's server/ modules (routes → service → repository, ports behind vendor/shared/adapters.ts, adapters constructed only in platform/container.ts) and reviewer-core's pure LLM-port design. Use when creating a new backend module, adding a DB or external-API dependency, wiring a new adapter, or reviewing existing backend code for layer/dependency violations. Does not cover Fastify plugin mechanics (see fastify-best-practices) or Drizzle query syntax (see drizzle-orm-patterns).
---

# Onion Architecture

DevDigest's backend already follows onion/hexagonal layering — this skill **names and codifies an existing convention**, it does not introduce a new one. Every rule below cites a real file in this repo as its canonical example. If you're proposing a change that contradicts one of these rules, that's a signal to re-check the existing pattern before treating this doc as stale.

## The Dependency Rule

Dependencies point **inward only**. Domain/business logic never imports infrastructure; infrastructure depends on interfaces the domain defines. Four rings, outer depends on inner:

| Ring | What it is | Where it lives |
|---|---|---|
| Domain core | Pure business/review logic, zero I/O | `reviewer-core/src/{prompt,grounding,review}/*`; each module's `service.ts` business logic |
| Application | Orchestration of domain logic | `modules/<name>/service.ts` |
| Ports | Interfaces the outer world implements | `server/src/vendor/shared/adapters.ts` |
| Infrastructure / Adapters | Concrete SDK/DB/network implementations | `server/src/adapters/*`, `reviewer-core/src/llm/openrouter.ts` |
| Composition root | Wires concrete adapters to ports | `server/src/platform/container.ts` |

See [`guides/layer-model.md`](guides/layer-model.md) for the full model, including how `reviewer-core` inverts this framing at the package level.

## When to Use

- Creating a new `modules/<name>/` (routes/service/repository).
- Adding any new external dependency: a DB table, an HTTP client, an LLM call, filesystem access.
- Touching `platform/container.ts` or `vendor/shared/adapters.ts`.
- Reviewing a PR or module for layer/dependency violations.

## Quick Reference

| If you're about to... | Do this instead | Why |
|---|---|---|
| Call GitHub directly from a route or service | Use `await container.github()` (typed as `GitHubClient`), never import `adapters/github/octokit.ts` | Only the composition root constructs concrete adapters |
| Query Drizzle from a `service.ts` or `routes.ts` | Add/use a method on that module's `repository.ts` | Repository is the only layer touching the DB for its domain |
| Add a new external API/provider | Add a port interface to `vendor/shared/adapters.ts` first, then an adapter under `adapters/*` | Domain/service code depends on the interface, not the SDK |
| Give `reviewer-core` a new capability that needs a DB row or a file read | Resolve it to a plain string/object in the caller (`server`), pass it in as data | `reviewer-core` has zero DB/GitHub/filesystem access by design |
| Add business branching logic to a route handler | Move it into `service.ts` | Routes are presentation-only: validate → call service → shape response |
| Return raw LLM findings without checking citations | Always pipe through `groundFindings()` | Grounding is a mandatory domain invariant, not optional post-processing |

## Guides

- [`guides/layer-model.md`](guides/layer-model.md) — the Dependency Rule in depth, `reviewer-core`'s package-level ring inversion, how onion relates to hexagonal/clean/N-tier, facades as an intra-ring pattern (not a ring boundary).
- [`guides/fastify-routing-and-di.md`](guides/fastify-routing-and-di.md) — routes-are-presentation-only, `Container`-based DI, composition-root discipline, good/bad examples.
- [`guides/drizzle-repository-pattern.md`](guides/drizzle-repository-pattern.md) — repository-owns-the-DB, facade-over-aggregate splitting, row types as an accepted DTO compromise, good/bad examples.
- [`guides/reviewer-core-llm-port.md`](guides/reviewer-core-llm-port.md) — `LLMProvider` as the sole side-effect boundary, the mandatory grounding gate, the `OpenRouterProvider`-lives-inside-the-core nuance, good/bad examples.
- [`guides/pitfalls-and-tradeoffs.md`](guides/pitfalls-and-tradeoffs.md) — when not to add a layer, anemic domain models, and which of this repo's compromises are intentional (don't flag them as bugs).
- [`references.md`](references.md) — the external reading list this skill draws on (origins, comparisons, Node/TS/Fastify/Drizzle/LLM-specific practical guides, pitfalls).

## Rules Checklist

Each rule carries a **stable identifier**. These ids are the citation vocabulary for reviews:
a finding names its id, then quotes the rule text below as its source. Ids are append-only —
rename one and every past review stops resolving.

| Id | Rule |
|---|---|
| `inward-only-dependencies` | Inner rings never import outer rings; only `platform/container.ts` (and each package's designated composition root) imports concrete adapters. |
| `port-before-adapter` | New external dependency → add a port interface to `vendor/shared/adapters.ts` before writing the adapter. |
| `sdk-imports-in-adapters` | SDK/client libraries (`octokit`, `openai`, etc.) are imported only inside `adapters/*` or a designated shared-provider file — nowhere else. |
| `di-discipline` | `service.ts` depends on `Container` (port-typed members), never `new`s a concrete adapter class itself. |
| `routes-presentation-only` | `routes.ts` is presentation-only: Zod validation → one or more service calls → response shaping. No direct repository/adapter calls, no business branching. |
| `repository-owns-db` | All Drizzle access for a domain lives in `modules/<name>/repository.ts` (optionally split into `repository/<aggregate>.repo.ts`, composed by a facade class). Services never import `db/schema.js` directly. |
| `module-registration` | New module = `routes.ts` + `service.ts` + `repository.ts` (as needed), registered once in `modules/index.ts` — no ad hoc extra top-level files, no bypassing the static registry. |
| `reviewer-core-zero-io` | `reviewer-core` stays free of DB/GitHub/filesystem access; new capabilities arrive as data or via the injected `LLMProvider`. |
| `reviewer-core-ground-findings-gate` | Never bypass `groundFindings()` for diff-anchored findings — it's a domain invariant, not an optional step. |
| `test-placement-mirrors-ring` | Test placement mirrors the ring: mocked-ports-only → `*.test.ts`; real-Postgres → `*.it.test.ts`. A "unit" test that needs a live DB is a signal a boundary leaked. |
| `match-layering-to-complexity` | Don't over-engineer small modules — match layering depth to actual domain complexity (see `guides/pitfalls-and-tradeoffs.md`). |
| `vendored-contracts-in-sync` | `server/src/vendor/shared/contracts/*` and `client/src/vendor/shared/contracts/*` are two copies of one contract with no automated sync — a one-sided edit is a breaking change. |
| `documented-deviation` | When reviewing existing code, don't flag this repo's documented, intentional compromises (whole-`Container` injection into services; row types doubling as DTOs) as bugs. This id marks a **suppression**, never a violation. |
