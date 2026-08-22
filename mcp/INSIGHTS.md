# INSIGHTS — mcp

Non-obvious decisions, gotchas, and "why is this built this way" for `mcp`.
Read before changing a long-standing convention, or when something behaves
surprisingly that the code alone doesn't explain.

Captured via the `engineering-insights` skill — see
[`.claude/skills/engineering-insights/SKILL.md`](../.claude/skills/engineering-insights/SKILL.md)
for entry format and the append-only rule. Sections are fixed; don't add,
remove, or rename them.

## What Works

_Nothing recorded yet._

## What Doesn't Work

_Nothing recorded yet._

## Codebase Patterns

- *2026-08-15 [Decision]* **A narrow local zod schema is how you cross a zod
  major-version boundary.** `mcp/` needs zod 4 (`@modelcontextprotocol/server@2`
  requires `^4.2.0`) while `server/` pins 3.25. Importing `@devdigest/shared` —
  or aliasing it in tsconfig `paths` — pulls zod-3-built types into
  `registerTool`'s StandardSchema inference and breaks it. `ports.ts` instead
  declares its own schemas over **only the fields this package reads**. This
  works because zod strips unknown keys by default, so a full API DTO parses
  cleanly and additive API changes cannot break the consumer. The duplication is
  the point, not a compromise.

- *2026-08-15 [Context]* **SDK v2 skips `outputSchema` validation when
  `isError: true`, but still transmits `structuredContent`.** That is what lets a
  tool with a declared `outputSchema` return a plain error message, and equally
  lets a failed run report `isError: true` *and* a structured
  `{ status, run_id, message }`. Evidence: `validateToolOutput` in
  `@modelcontextprotocol/server/dist/mcp-*.mjs` returns early on `result.isError`.

- *2026-08-15 [Decision]* **`isError` means "correctable or genuinely failed",
  not "empty".** A legitimate empty-or-pending state — nothing reviewed yet,
  nothing extracted yet, still running, stub not implemented — is
  `isError: false` with a `message`. Flagging "no data yet" as an error teaches
  the model to give up on a healthy system. Decided once here so it can't drift
  tool by tool.

## Tool & Library Notes

- *2026-08-15 [Mistake]* **`npm run <script>` writes 50 bytes to stdout before
  the script starts, corrupting an MCP stdio server's first JSON-RPC frame.**
  Measured on this package: `npm run start < /dev/null | wc -c` → **50**;
  `npm run --silent start` → **0**. The symptom is a contentless "server failed
  to connect" with no error text, which points nowhere near the cause. Hence
  `--silent` in `mcp/devdigest.mcp.json`. This is separate from — and additional to —
  the no-`console.log`-in-`src/` rule; either mistake produces the same useless
  symptom.

- *2026-08-15 [Mistake]* **An MCP `ToolResult` must be a `type` alias, not an
  `interface`.** SDK v2's `CallToolResult` carries an `[x: string]: unknown`
  index signature, and TypeScript grants an implicit index signature only to type
  aliases. An `interface` with identical members fails to assign with a
  misleading `Property 'resultType' is missing` error pointing at the wrong union
  member (`InputRequiredResult`). See `src/shape.ts`.

- *2026-08-15 [Context]* **Measured MCP tool-definition cost is ~2.4× the
  description text alone**, because `outputSchema` compiles to JSON Schema and is
  re-sent every turn. This estimate was walked from 860 → 1,350 → a measured
  **1,354** tokens for five tools. Estimating a token budget from description
  strings alone is off by roughly half — measure the real `tools/list` payload
  (`InMemoryTransport` + `Client.listTools()` + `js-tiktoken`), which is what
  `test/token-budget.test.ts` now does on every run.

- *2026-08-16 [Mistake]* **`claude mcp list` does not show a server passed via
  `--mcp-config`, and its absence there is not evidence of failure.** That
  command reports only *persisted* registrations — user, project, and local
  scope. A server supplied by the `--mcp-config` flag is scoped to the running
  session and is never written to any of them, so it is missing from the list
  while connected and fully working. The real check is `/mcp` **inside** the
  session; the definitive one is calling a tool (`list_agents` is the cheapest —
  no arguments, and it fails loudly if the API on `:3001` is down). This package
  is opt-in *precisely* so it isn't auto-discovered, which means the misreading
  is not a one-off: anyone diagnosing from outside the session will see the same
  empty list and can conclude the setup is broken when nothing is. Cost when it
  happened here: a working setup was reported as unavailable and several
  exchanges went to a bug hunt with no bug.

### 2026-08-20 — [Decision] `get_blast_radius` reports `not_indexed` as a distinct status, not an empty map

An unindexed repo and a repo whose changed files genuinely reach nothing both
produce an empty blast map, and only one of them means "nothing is affected". The
tool branches on `blast.index.status === 'missing'` and returns
`{ status: 'not_indexed', message }` with `isError: false`; for a `partial` or
`failed` index it returns the map plus an explicit `caveat` string rather than
leaving the model to infer significance from a status enum it has no prior for.
Wiring the tool cost 45 tokens (110 → 155) and left the suite at 1373/1600.
Evidence: `mcp/src/tools/get-blast-radius.ts:29-38`, `mcp/src/shape.ts`.


## Recurring Errors & Fixes

_Nothing recorded yet._

## Session Notes

_Nothing recorded yet._

## Open Questions

_Nothing recorded yet._
