# CLAUDE.md — e2e (`@devdigest/e2e`)

Deterministic browser flows for the web app, driven by Vercel `agent-browser`
(Rust + CDP) — no Playwright, no LLM, no API key. See root
[`CLAUDE.md`](../CLAUDE.md) for cross-package conventions.

## Stack

`agent-browser` CLI (installed globally), plain JSON flow specs, `run.ts` runner.

## Commands

`./scripts/e2e.sh` — hermetic, recommended (isolated stack on alternate ports,
freshly seeded every run). `cd e2e && npm test` — only safe if your dev DB
contains *only* the seeded demo repo (otherwise flows land on the wrong repo).

## Map

`specs/NN-name.flow.json` — one JSON list of `agent-browser` commands per flow;
this **is** the specs directory. `run.ts` — executes flows in order against one
shared browser session.

## Non-default conventions

- Locators must be deterministic only: `--url`, `--text`, `find role|text|label`
  — never the AI `chat` command, or runs stop being key-free and stable.
- Flows assume read-only seeded data (`acme/payments-api`, PR #482) — don't add
  a flow that mutates state another flow depends on.

## Do-not-touch / danger

Never `docker compose down -v` to "reset" — deletes `devdigest_pgdata` and every
real repo/review you've imported, not just e2e state.

## Read when…

| Doc | Read when |
|---|---|
| [`README.md`](README.md) | flow spec format, coverage table, env knobs |
| [`docs/README.md`](docs/README.md) | currently a stub |
| `specs/*.flow.json` | the actual specs — read directly, this is not a stub |
| [`INSIGHTS.md`](INSIGHTS.md) | before changing a long-standing convention, or something behaves surprisingly |
