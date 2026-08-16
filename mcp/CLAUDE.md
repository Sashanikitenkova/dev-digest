# CLAUDE.md — mcp (`@devdigest/mcp`)

Local stdio MCP server that exposes DevDigest's review engine to an AI coding
agent (Claude Code, Claude Desktop, any MCP host) as **five workflow-level
tools**. It is a **pure HTTP consumer** of the DevDigest API on `:3001` — no DB,
no secrets, no LLM keys, no `server/src/**` imports. See root
[`CLAUDE.md`](../CLAUDE.md) for cross-package conventions.

## Stack

MCP SDK v2 (`@modelcontextprotocol/server@2`), **zod 4**, `tsx`. Node ≥22.

## Commands

`npm test` (vitest, hermetic — stub port, no API, no DB, no Docker) ·
`npm run typecheck` — **this is the build**; the package never emits JS ·
`npm run start` / `npm run dev` — `tsx src/index.ts`.

Package manager here is **npm** (own `package-lock.json`), like `reviewer-core/`
and `e2e/`. There is no workspace — never run `pnpm -w` anything.

## Map

Layered per the [`onion-architecture`](../.claude/skills/onion-architecture/SKILL.md)
skill. The rings map cleanly even with no DB and no Fastify:

| Ring | Files | Rule |
|---|---|---|
| Domain | `shape.ts`, `errors.ts` | pure functions, zero I/O |
| Application | `resolve.ts`, `tools/*.ts` | orchestration; depends on the **port** |
| Port | `ports.ts` → `DevDigestApi` | the interface the outer world implements |
| Adapter | `adapters/http-api.ts` | the **only** file that touches `fetch` |
| Presentation | `server.ts` | `registerTool` only; no logic |
| Composition root | `index.ts` | the only file that constructs the adapter |

## Non-default conventions

- 🚨 **stdout purity.** stdout is the JSON-RPC frame channel. **Never**
  `console.log` or `process.stdout.write` anywhere in `src/**` — all diagnostics
  go to stderr via `console.error`. Verify before finishing:
  `rg -n 'console\.log|process\.stdout\.write' mcp/src` must return nothing.
  The launch command must also carry `--silent`: `npm run start` otherwise
  prints its own 50-byte `> @devdigest/mcp@0.0.0 start` banner to stdout and
  corrupts the first frame. The symptom of either mistake is a useless
  "server failed to connect" with no error text.
- **zod 4 here, zod 3 everywhere else.** `@modelcontextprotocol/server` requires
  `zod ^4.2.0`; `server/` pins 3.25. Never import from `server/src/**` and never
  add a tsconfig `paths` alias to `@devdigest/shared` — zod-3-built types break
  `registerTool`'s StandardSchema inference. `ports.ts` declares its own narrow
  zod-4 schemas over only the fields this package reads; zod strips unknown keys
  by default, so a full API DTO parses fine and additive API changes cannot
  break us.
- **No build step.** Runs from source under `tsx`, like every other runnable
  entrypoint in this repo (`server/src/db/migrate.ts`, `e2e/run.ts`). No `tsc`
  build, no `dist/`.
- 🚫 **Opt-in only — never auto-started.** Two invariants, both deliberate:
  (1) `scripts/dev.sh` must **never** launch this server. An MCP stdio server is
  spawned by the *host* over a pipe, so starting it from the dev stack would
  leave a process with nothing on its stdin. (2) The config is
  `mcp/devdigest.mcp.json`, **not** a repo-root `.mcp.json` — that filename is
  auto-discovered by Claude Code and would connect on every session in this repo.
  You opt in per session with
  `claude --mcp-config mcp/devdigest.mcp.json` (run from the repo root).
  Do not "helpfully" restore either one. Verify the result **inside** the
  session with `/mcp` — **not** `claude mcp list`, which reports only persisted
  user/project/local registrations. A `--mcp-config` server is session-scoped
  and is absent from that list even while connected and working, so its absence
  there is not evidence of failure.
- **The DevDigest API must be running** (`./scripts/dev.sh`). That is the
  accepted trade-off of the HTTP-client design, and it is mitigated by an
  explicit error, not solved.
- **The five descriptions in `server.ts` are verbatim from the approved plan.**
  They are re-sent on every turn and were chosen for their effect on
  tool-selection accuracy. Do not reword them to fit a budget —
  `test/token-budget.test.ts` measures the real payload, and the plan carries an
  ordered trim list.

## Gotchas

- **`isError` policy — decided once, don't drift.** `isError: true` means *the
  model did something it can correct* (bad name, wrong tool, API down) or *the
  operation genuinely failed*. A legitimate empty-or-pending state — nothing
  reviewed yet, nothing extracted yet, still running, stub not implemented — is
  `isError: false` with a `message`. Flagging "no data yet" as an error teaches
  the model to give up on a healthy system.
- **`GET /repos/:id/pulls` is not a cheap read.** With a GitHub token it syncs
  every PR and backfills diff stats for up to 10 — seconds, not milliseconds.
  There is no `GET /repos/:id/pulls/:number`. Resolve repo and agent (cached)
  before the PR, so a mistyped agent name fails before that cost.
- **Cache only positive results.** `resolve.ts` memoizes repo and agent lookups
  for the process lifetime, never PR lookups and never misses — a repo or PR can
  be imported mid-session, and a cached miss would make retry impossible.
- Nullability traps, all guarded: `PrMeta.id` is `.nullish()`; `ReviewDto.run_id`
  and `agent_id` are nullable; `RunSummary.status` is nullable; `ReviewDto.kind`
  is `'summary' | 'review'` and a multi-agent round emits a `summary` roll-up.
- Agent names have **no unique index** on `(workspace_id, name)`. An ambiguous
  match throws a message naming the duplicates rather than picking one.
- `ToolResult` in `shape.ts` is a `type` alias, not an `interface` — only type
  aliases get an implicit index signature, which the SDK's `CallToolResult`
  requires.

## Read when…

| Doc | Read when |
|---|---|
| [`README.md`](README.md) | registering the server in a host, the measured token cost, or finishing the `get_blast_radius` homework |
| [`INSIGHTS.md`](INSIGHTS.md) | before changing a long-standing convention, or something behaves surprisingly |
| [`../server/CLAUDE.md`](../server/CLAUDE.md) | you need to understand the API this consumes (read only — never edit from here) |
