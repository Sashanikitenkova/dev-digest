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


### 2026-08-29 — [Decision] The config moved to a repo-root `.mcp.json`, superseding the opt-in invariant

`mcp/devdigest.mcp.json` was named that way *deliberately* so Claude Code would
not auto-discover it, and you opted in per session with
`claude --mcp-config mcp/devdigest.mcp.json`. That decision is **superseded**:
the config is now `.mcp.json` at the repo root, carrying `type: "stdio"` and
`timeout`, and the host connects on its own.

What the old invariant bought — a repo where a plain `claude` never spawned the
server — is genuinely lost, and that cost is accepted rather than solved.
Automatic connection became the requirement. The *other* half of the old
invariant still holds and was not touched: `scripts/dev.sh` must never launch
this server, because an MCP stdio server is spawned by the host over a pipe and
would otherwise sit with nothing on its stdin.

Note `type` and `timeout` are not decoration — without `type: "stdio"` the host
does not reliably infer the transport, which presents as a silent failure to
connect rather than an error.
Evidence: `.mcp.json`, `mcp/CLAUDE.md`, `mcp/README.md`.

### 2026-08-29 — [Pattern] Env validation belongs in `config.ts`, and `loadConfig` must throw rather than exit

`index.ts` read `process.env` directly with `?? default` fallbacks, so a
malformed `DEVDIGEST_API_BASE` passed startup and failed later at the first
`fetch` — a per-tool error that looked like the API was down. `src/config.ts`
now parses the environment through zod once, following
`server/src/platform/config.ts`.

Two non-obvious details:

- **`loadConfig` throws `ConfigError`; it never calls `process.exit`.** The exit
  lives in `index.ts`. A `process.exit()` inside `loadConfig` would take the
  vitest worker down with it the moment a test exercised the invalid-input path,
  so the split is what makes fail-fast testable at all.
- **`z.url()` does not strip a trailing slash.** `http://host:3001/` validates
  happily and then builds `//pulls/...` downstream. The schema transforms it
  away explicitly.

Evidence: `mcp/src/config.ts`, `mcp/src/index.ts`, `mcp/test/config.test.ts`.

### 2026-08-29 — [Decision] `get_findings` returns a list of reviews, and a false description is worth its tokens to fix

`get_findings` collapsed a pull request to its single newest review and spread it
flat. A PR has one review **per agent**, so every other agent's review was
dropped with no signal it existed. It now returns
`{ reviews: [...], total_findings }` with findings nested per review.

`total_findings` sums the **full** per-review counts, not the truncated arrays —
the same rule as `findings_count` — so truncation stays visible. `max_findings`
stays a **per-review** cap; making it a global budget would starve whichever
review was iterated last, depending on order.

The reshape also forced a rule change. `mcp/CLAUDE.md` said the five tool
descriptions are verbatim and must not be reworded; but this one now claimed to
return "the latest completed review", which was false. A description that
misdescribes its tool corrupts selection far worse than its token cost, so
correcting a *factually wrong* description is now an explicit exception to that
rule — distinct from rewording to fit a budget, which is still forbidden. The
corrected wording measured 3 tokens **cheaper**.

Budget after both changes: `get_findings` 403 → 430 of 450 (thin — 20 spare),
total 1373 → 1400 of 1600.
Evidence: `mcp/src/tools/get-findings.ts`, `mcp/src/shape.ts` (`shapeReviewList`),
`mcp/src/server.ts` (`FindingsOut`).


## Recurring Errors & Fixes

_Nothing recorded yet._

## Session Notes

_Nothing recorded yet._

## Open Questions

_Nothing recorded yet._
