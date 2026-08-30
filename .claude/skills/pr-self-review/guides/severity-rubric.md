# Severity Rubric

Normalizes every skill's own vocabulary (e.g. `react-best-practices`'
CRITICAL/HIGH/MEDIUM tags, `security`'s HIGH/MEDIUM/LOW confidence tiers,
`typescript-expert`'s `risk: critical` metadata) to one shared scale, so findings from
different skills can sit in a single report and drive one merge gate.

## Critical — blocks merge

- Failing `pnpm typecheck` / `vitest` / build in any touched package.
- A finding-producing code path that bypasses `groundFindings()` — grounding is a
  mandatory domain invariant per root `CLAUDE.md` and `onion-architecture`, not an
  optional post-processing step.
- A route or service reaching the DB or a concrete adapter directly (an
  onion-architecture dependency-rule break — e.g. `routes.ts` calling
  `db/schema` or `adapters/*` instead of going through `service.ts` →
  `repository.ts`).
- A new external dependency (DB table, HTTP client, LLM call) wired without a port
  interface added to `vendor/shared/adapters.ts` first.
- A real, reproducible security exploit path (not a theoretical one) —
  injection, auth bypass, secret exposure, etc.
- A migration with genuine data-loss/corruption risk: dropping/renaming a column
  still read by running code, or adding a NOT NULL column with no default/backfill.
  Migrations are not applied on boot (`pnpm db:migrate` is manual per root
  `CLAUDE.md`), so nothing else in the pipeline catches this before it ships.
- A shared-contract change where `server/src/vendor/shared/contracts/*` and
  `client/src/vendor/shared/contracts/*` go out of sync — there's no automated sync,
  so a one-sided edit is a silent breaking change.

## High — strong warning, requires explicit confirmation to proceed

- A correctness bug likely to manifest in normal use (not just an edge case).
- Missing input validation on a user-facing route (Zod schema absent or incomplete
  for a new endpoint).
- A meaningful onion-architecture layering violation that doesn't break the build
  (e.g. business branching logic living in `routes.ts` instead of `service.ts`).
- A new/altered FK column with no index — Postgres does not auto-index foreign keys.
- A CRITICAL/HIGH-tagged finding from `react-best-practices` (hooks misuse, a
  correctness-affecting anti-pattern).
- Secrets or LLM/GitHub keys handled outside `~/.devdigest/secrets.json` (e.g. written
  to `.env` or the DB) — root `CLAUDE.md` is explicit this must never happen.

## Medium — informational, never blocks

- Code smell or reuse opportunity (`simplify` findings default here).
- Non-idiomatic Drizzle/Zod usage that works but diverges from documented patterns.
- Missing test coverage for new business logic.
- Minor Fastify/Next.js convention deviation (e.g. a barrel file, a private-folder
  convention miss).

## Low — informational, never blocks

- Style/naming nits.
- Optional refactor suggestions.
- Doc/comment improvements.

## Don't flag as issues at all

Per `onion-architecture`'s own `guides/pitfalls-and-tradeoffs.md`, this repo has
documented, intentional compromises — never raise these as findings at any severity:

- `service.ts` constructors depending on the whole `Container` rather than narrowly
  scoped injected ports.
- Row types (`db/rows.ts`) doubling as DTOs.
- A small, low-complexity module (e.g. `modules/settings/`) skipping a full
  `repository.ts` split that a larger domain (e.g. `modules/reviews/`) has.

If a future skill raises one of these as a finding, downgrade it to "no finding" in
the verify pass (`SKILL.md` step 8) rather than reporting it at any severity.
