# CLAUDE.md

DevDigest — local-first AI PR review tool; course-starter architecture (see
`README.md` for what later lessons add). Four independent packages, **no
pnpm/npm workspace** — don't run `pnpm -w ...`. Cross-package code is a
tsconfig path alias (`reviewer-core` consumed as source by `server`) or
vendored copies (`@devdigest/shared`, `@devdigest/ui`), not installable deps.

## Stack

Node ≥22 · pnpm ≥10 · Docker (Postgres/pgvector only — API & web run on host).

## Packages

| Path | Package | Role | Port | Run | Test |
|---|---|---|---|---|---|
| `server/` | `@devdigest/api` | Fastify 5 + Drizzle/Postgres; hosts the review engine | 3001 | `pnpm dev` | `pnpm test` |
| `client/` | `@devdigest/web` | Next.js 15 studio (UI) | 3000 | `pnpm dev` | `pnpm test` |
| `reviewer-core/` | `@devdigest/reviewer-core` | pure engine: diff → prompt → LLM → grounded findings | — | — | `npm test` |
| `e2e/` | `@devdigest/e2e` | deterministic browser flows (agent-browser, no LLM) | — | `./scripts/e2e.sh` | — |

Quick start: `./scripts/dev.sh` (Postgres up, deps, migrate, seed, launch API+web).

## Non-default conventions

- No workspace linking — each package has its own lockfile; don't `pnpm add` a sibling package.
- Secrets (LLM/GitHub keys) live in `~/.devdigest/secrets.json` (mode 0600), never `.env`/DB.
- Migrations are **not** applied on boot — run `pnpm db:migrate` in `server/` manually.
- Review grounding is mandatory across the pipeline — every finding must cite a real diff line or it's dropped.

## Do-not-touch

- `server/clones/**` — gitignored runtime checkouts of imported repos.
- `.next/`, `node_modules/`, vendored `src/vendor/**` (unless deliberately resyncing).
- Never `docker compose down -v` against the dev stack — deletes `devdigest_pgdata` and every imported repo/review with it.

## Module CLAUDE.md

AUTO-loads per folder; listed here too as a manual fallback — the VS Code
extension has a known bug (issue #24987) where AUTO-load can miss.

| Folder | CLAUDE.md |
|---|---|
| `server/*` | [`server/CLAUDE.md`](server/CLAUDE.md) |
| `client/*` | [`client/CLAUDE.md`](client/CLAUDE.md) |
| `reviewer-core/*` | [`reviewer-core/CLAUDE.md`](reviewer-core/CLAUDE.md) |
| `e2e/*` | [`e2e/CLAUDE.md`](e2e/CLAUDE.md) |

## Session protocol — Engineering Insights

Before starting any work, identify which package(s) the request touches
(`client/`, `server/`, `reviewer-core/`, `e2e/` — code under
`server/src/modules/repo-intel` counts as `server/`) and read that
package's `INSIGHTS.md`. Treat its contents as high-confidence working
context for analysis, planning, and implementation.

During the session, watch for engineering insights worth keeping —
architectural decisions, implementation patterns, pitfalls, performance
findings, debugging discoveries, framework-specific behavior, integration
constraints. Before recording one, re-check the target file for a
duplicate or near-duplicate and skip it if one already exists.

At the end of the session, decide whether anything substantial enough was
discovered (bar defined in
[`.claude/skills/engineering-insights/SKILL.md`](.claude/skills/engineering-insights/SKILL.md)).
If nothing meets it, make no changes — an empty review is correct, not a
failure. If something does, append it to the matching package's
`INSIGHTS.md`. Never overwrite or delete a past entry; if one is now
wrong, append a new dated entry that supersedes it instead.

## Read when…

| Doc | Read when |
|---|---|
| [`README.md`](README.md) | you need the architecture diagram or full setup |
| [`TESTING.md`](TESTING.md) | touching tests or CI workflows |
| [`docs/agent-prompts/`](docs/agent-prompts/README.md) | working on agent prompts or model choice |
