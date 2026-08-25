# Skill Matrix

Glob → skill mapping used to build the skill-execution matrix in `SKILL.md` step 4.
A skill runs **once**, against the full set of changed files that matched its
condition — never once per file.

| Skill | Category | Scope | Trigger condition | Notes |
|---|---|---|---|---|
| `code-review` (global) | QA | — | always, any changed file | Correctness bugs + reuse/simplification/efficiency. |
| `security-review` (global) | QA | — | always, any changed file | Primary security gate; can surface Critical findings. |
| `simplify` (global) | QA | — | always, any non-doc changed file | Advisory only — quality, not correctness; never raises a Critical on its own. |
| `verify` (global) | QA | — | changed files include runtime source (not only `*.test.*`/docs) | Drives the affected flow end-to-end; skip on test/doc-only diffs per its own rule. |
| `onion-architecture` | Architecture | Backend | `server/src/**` (excl. `server/src/vendor/shared/**`), `reviewer-core/src/**` | Layer/dependency-direction violations; grounding-gate bypass is Critical. |
| `fastify-best-practices` | Tech | Backend | `server/src/modules/**/routes.ts`, `server/src/platform/*.ts`, `server/src/server.ts` | Route/plugin conventions, validation, error handling. |
| `drizzle-orm-patterns` | Tech | Backend | `server/src/db/**` | Schema, queries, relations, transactions, migrations. |
| `postgresql-table-design` | Tech | Backend | `server/src/db/schema/**`, `server/src/db/migrations/**` | Data types, indexing (esp. FK columns — Postgres does not auto-index them), constraints. |
| `frontend-architecture` | Architecture | Frontend | `client/src/**` | Folder structure, code placement, module boundaries. |
| `react-best-practices` | Tech | Frontend | `client/src/**/*.tsx`, `*.jsx` | Anti-patterns, hooks misuse, performance. |
| `next-best-practices` | Tech | Frontend | `client/src/app/**` | App Router conventions, RSC boundaries, metadata. |
| `react-testing-library` | Tech/QA | Frontend | `client/**/*.test.tsx` | Query priority, async patterns, mocking-at-boundaries. |
| `zod` | Tech | Full-stack | `**/vendor/shared/contracts/**`, any file defining/importing `z.object` | Includes the `.nullish()` vs `.nullable()` convention already documented in `server/INSIGHTS.md`. |
| `typescript-expert` | Tech | Full-stack | Heuristic only: generics-heavy changes, `tsconfig.json`/`.d.ts` edits | Not run on every `.ts` file — would be noise; only when type-level complexity is actually introduced. |
| `security` (local) | Tech | Full-stack | Files touching auth/session/JWT/upload/input-handling | Apply adapted to this stack (Fastify/Postgres) — its own examples are Express/MongoDB-shaped; don't flag Mongo/Express-specific advice verbatim. |
| `mermaid-diagram` | — | Shared | never | Not review-relevant; excluded from the matrix entirely. |
| `run-plan` | — | Project | never | Orchestrator, not a reviewer — it *invokes* this gate as its own Phase 6. Listed so the matrix stays complete; never matched against a diff. |
| `engineering-insights` | — | Project | end-of-run only, opportunistic | Only if the review surfaced a genuinely new non-obvious pattern worth recording — this skill never gates the merge. |

## Shared-contracts special case

Any change under `server/src/vendor/shared/**` or `client/src/vendor/shared/**` runs
**both** the backend and frontend matrices (not just one), plus an explicit manual
check that the two vendored copies still match — there is no automated sync between
them (a real gotcha already logged in `server/INSIGHTS.md`).

## Maintenance

When a new project-local skill is added to `.claude/skills/`, add its glob condition
to this table in the same change. An unmaintained matrix silently stops matching new
skills — the same way the README's `.cursor/skills` symlink claim went stale without
anyone noticing.
