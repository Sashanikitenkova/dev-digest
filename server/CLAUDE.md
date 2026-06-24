# CLAUDE.md — server (`@devdigest/api`)

Fastify 5 + Drizzle/Postgres backend: imports repos/PRs, indexes via
`repo-intel`, runs the reviewer (`reviewer-core`), stores agents/findings.
Adapters sit behind a DI container (`platform/container.ts`) so tests swap in
mocks. See root [`CLAUDE.md`](../CLAUDE.md) for cross-package conventions.

## Stack

Fastify 5, Drizzle ORM, `postgres` + pgvector, Zod (`fastify-type-provider-zod`),
octokit, simple-git, `@ast-grep/napi`, dependency-cruiser, graphology, js-tiktoken.

## Commands

`pnpm dev` (:3001) · `pnpm db:migrate` · `pnpm db:seed` · `pnpm typecheck` ·
`pnpm exec vitest run --exclude '**/*.it.test.ts'` (unit) ·
`pnpm exec vitest run .it.test` (integration, needs Docker) · `pnpm test` (both).

## Map

`modules/<name>/{routes,service,repository}.ts` — one plugin per domain,
registered in `modules/index.ts`. `platform/container.ts` — DI container.
`adapters/*` — ports (llm, github, git, astgrep, secrets, tokenizer…).
`db/schema/*` — Drizzle tables; **every** future-lesson table already exists
(skills, memory, eval, ci, multi-agent…) — don't delete an "unused" one.

## Non-default conventions

- `reviewer-core` is imported as TypeScript **source** via a tsconfig path
  alias, not a published package — never `pnpm add @devdigest/reviewer-core`.
- Secrets resolve through `SecretsProvider` (`~/.devdigest/secrets.json`,
  mode 0600, `process.env` fallback) — not `AppConfig`/`.env`.
- Routes validate via Zod `params`/`body` schemas (`fastify-type-provider-zod`)
  before the handler runs — don't hand-roll `Schema.parse(req.body)`.

## Gotchas

- Migrations are **not** applied on boot.
- `server/package.json` is `skip-worktree` — CI calls `vitest` directly rather
  than relying on its scripts (see `../TESTING.md`).
- A DB-backed test **must** be named `*.it.test.ts` or the unit/integration
  split silently miscategorizes it.

## Do-not-touch

`clones/**` — gitignored runtime checkouts.

## Read when…

| Doc | Read when |
|---|---|
| [`README.md`](README.md) | request/DI flow, API map, review-context details |
| [`src/modules/repo-intel/README.md`](src/modules/repo-intel/README.md) | working on indexing / repo map / blast radius |
| [`docs/README.md`](docs/README.md) | digging into a specific subsystem — currently a stub |
| [`specs/README.md`](specs/README.md) | implementing a feature — currently a stub |
| [`INSIGHTS.md`](INSIGHTS.md) | before changing a long-standing convention, or something behaves surprisingly |
| [`../TESTING.md`](../TESTING.md) | touching tests or CI |
