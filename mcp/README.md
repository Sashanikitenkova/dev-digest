# `@devdigest/mcp` — DevDigest as an MCP server

A local **stdio** MCP server that turns DevDigest's review engine into something
an AI coding agent can drive: list the configured reviewers, run one on a pull
request, read back the findings, read the repo's extracted conventions.

It is a **pure HTTP consumer** of the DevDigest API on `http://localhost:3001`.
It holds no database connection, no LLM keys and no GitHub token, and it imports
nothing from `server/src/**`. Reviews keep running inside the API process, so
the studio's live SSE trace still works while an agent drives a review.

## Prerequisite: the API must be running

```bash
./scripts/dev.sh          # Postgres up, migrate, seed, launch API (:3001) + web (:3000)
```

This is the accepted trade-off of the HTTP-client design. It is **mitigated, not
solved**: with the API down, every tool returns

```
DevDigest API is not reachable at http://localhost:3001 — start it with ./scripts/dev.sh
```

rather than a bare connection error, so the agent knows what to do next.

## Starting it — automatic

The config lives at the **repo root** as `.mcp.json`, which Claude Code
auto-discovers. Open a session in this repo and the `devdigest` server connects
on its own — no flag:

```bash
claude
```

Verify with `/mcp` **inside** the session. Do not use `claude mcp list`; it
reports only persisted user/project/local registrations.

> The first session after this file appears may ask you to approve the project's
> MCP servers. Approve once and it is remembered. To skip even that, add
> `{ "enableAllProjectMcpServers": true }` to `.claude/settings.json`.

> **This reverses an earlier decision.** The config used to be
> `mcp/devdigest.mcp.json`, named that way *specifically* so it would not be
> auto-discovered, and you opted in per session with
> `claude --mcp-config mcp/devdigest.mcp.json`. That bought you a repo where a
> plain `claude` never spawned the server; the cost was that it never connected
> unless you remembered the flag. Automatic connection is now the requirement,
> and the old cost is accepted.

### The config

`.mcp.json`, at the repo root:

```json
{
  "mcpServers": {
    "devdigest": {
      "type": "stdio",
      "command": "npm",
      "args": ["--prefix", "./mcp", "run", "--silent", "start"],
      "timeout": 30000,
      "env": {
        "DEVDIGEST_API_BASE": "http://localhost:3001",
        "DEVDIGEST_WEB_BASE": "http://localhost:3000"
      }
    }
  }
}
```

`type` and `timeout` are both required by the host. Both env vars are optional;
the values above are also the built-in defaults. `DEVDIGEST_WEB_BASE` is used
only inside error messages that point you at the studio.

Both are **validated at startup** by `src/config.ts` (zod). A malformed URL
fails the process immediately with a message on stderr and exit code 1, rather
than surfacing later as a confusing per-tool error:

```
$ DEVDIGEST_API_BASE=not-a-url npm run --silent start
[devdigest-mcp] Invalid DevDigest MCP environment:
  DEVDIGEST_API_BASE: Invalid URL
```

> ⚠️ **`--silent` is not optional.** Measured on this package: `npm run start`
> writes **50 bytes** of its own `> @devdigest/mcp@0.0.0 start` banner to stdout
> before the server starts. stdout is the JSON-RPC frame channel, so those 50
> bytes corrupt the first frame and the host reports a contentless "server failed
> to connect". With `--silent`, stdout is **0 bytes** until the first real frame.

> ⚠️ **Relative `--prefix`.** `./mcp` is resolved from the repo root, where
> `.mcp.json` lives. If you start Claude Code from elsewhere, substitute an
> absolute path.

### Debugging without a host

MCP Inspector drives the server directly — no Claude Code involved:

```bash
cd mcp
npx @modelcontextprotocol/inspector npx tsx src/index.ts
```

## The five tools

Names are unprefixed on purpose — MCP hosts already namespace by server
(`devdigest:list_agents` in Claude Code), so a `devdigest_` prefix would
duplicate that and spend tokens on every turn.

### `list_agents` — read-only, no arguments

Lists the review agents configured in DevDigest. Call this first to get a valid
agent name for `run_agent_on_pr`.

Returns `{ agents: [{ name, description, model, enabled }] }`. Disabled agents
**are** included, flagged — running one explicitly by id is a legal call.
`system_prompt` is never returned (a single seeded prompt runs to thousands of
tokens); `test/list-agents.test.ts` asserts its absence in every channel.

### `run_agent_on_pr` — the one writing tool

| Argument | Type | Meaning |
|---|---|---|
| `repo` | `string` | Repository as `"owner/name"`, e.g. `"acme/payments-api"`. |
| `pr` | `number` | Pull request number, e.g. `482`. |
| `agent` | `string` | Agent name from `list_agents`. |
| `max_findings` | `number?` | Most severe first. Defaults to 20. |

Starts the run, **waits for it**, and returns
`{ status, run_id, verdict, score, summary, agent, findings_count, findings[] }`
in one call. `findings_count` is the review's full count even when `findings` is
truncated, so truncation is visible.

Waiting is HTTP polling of `GET /pulls/:id/runs` every 2s (not SSE: the API's
`runBus` is a per-process singleton). After **5 minutes** it returns a degraded
but useful result rather than hanging:

```
{ "status": "still_running", "run_id": "…",
  "message": "The review is still running after 5 minutes. Call get_findings with the same repo and pr to collect the result." }
```

`rationale` is deliberately omitted here — it is markdown and frequently long.

### `get_findings` — read-only

Returns the verdicts and findings from **every** completed review of a pull
request, **without running a new one**.

| Argument | Type | Meaning |
|---|---|---|
| `repo` | `string` | Repository as `"owner/name"`. |
| `pr` | `number` | Pull request number. |
| `agent` | `string?` | Only this agent's reviews. Defaults to every agent's. |
| `detail` | `boolean?` | Include each finding's full `rationale` (and `confidence`). Defaults to `false`. |
| `max_findings` | `number?` | Most severe first, **per review**. Defaults to 20. |

A pull request has one review **per agent**, so the result is a list:

```json
{
  "status": "ok",
  "reviews": [
    { "agent": "Security Reviewer", "verdict": "request_changes", "score": 4,
      "summary": "…", "findings_count": 12, "findings": [ … ] },
    { "agent": "API Contract Reviewer",
      "findings_count": 3, "findings": [ … ] }
  ],
  "total_findings": 15
}
```

Reviews come back newest-first. `findings_count` is one review's full count and
`total_findings` is the pull request's whole surface — both are the **real**
counts, never the truncated array lengths, so truncation stays visible and the
model can tell that raising `max_findings` would return more.

`max_findings` caps each review independently rather than acting as a global
budget, which would starve whichever review was iterated last.

Nothing reviewed yet is a healthy state, not an error — `isError` is unset:

```json
{ "status": "no_review", "message": "… Call run_agent_on_pr …" }
```

### `get_conventions` — read-only

Returns the coding conventions DevDigest extracted from a repository, each with
the file and line that evidences it.

| Argument | Type | Meaning |
|---|---|---|
| `repo` | `string` | Repository as `"owner/name"`. |
| `status` | `"accepted" \| "pending" \| "rejected"?` | Defaults to `accepted`. |
| `max` | `number?` | Highest confidence first. Defaults to 30. |

Convention rows are precomputed and never lazily extracted, so an empty result
is **not** "this repo has no conventions". It returns guidance instead:

```
No conventions have been extracted for this repository yet. Run the conventions extractor from the DevDigest UI, or POST /repos/{id}/conventions/extract.
```

### `get_blast_radius` — read-only

Answers "what else could this diff affect?" from the repo index: the symbols the
PR changed, who calls them, and which endpoints or crons sit downstream. No model
is involved on either side — the server derives every node and edge from
`symbols` / `references` / `file_edges`, and this tool only shapes them.

| Argument | Type | Meaning |
|---|---|---|
| `repo` | `string` | Repository as `"owner/name"`. |
| `pr` | `number` | Pull request number. |

Returns `{ status: "ok", index_status, summary, changed_symbols, symbols[],
impacted_endpoints, impacted_crons, caveat? }`. Per symbol, `callers` collapse to
`path:line` strings, and direct vs. indirect impact live in **separate** keys
(`endpoints` vs `endpoints_indirect`): a 2-hop endpoint reached through a barrel
file is much weaker evidence than one whose own file calls the changed symbol.

An unindexed repo is reported as its own status, **not** as an empty map — those
two must never collapse into one answer, and it is `isError: false` because "not
indexed yet" is a healthy state:

```json
{ "status": "not_indexed", "message": "…" }
```

When the index is `partial` or `failed`, a `caveat` field spells out that an
empty result means "not known", not "nothing is affected".

It declares **no `outputSchema`** — see the token table below.

## Measured token cost

Every tool's name, description and JSON Schema is injected at session start and
re-sent on **every turn**, so this is a real recurring tax. `npm test` measures
it against the actual `tools/list` wire payload (`js-tiktoken`, `cl100k_base`,
over a live `InMemoryTransport` + `Client.listTools()`), not an estimate:

| Tool | Params | **Measured tokens** |
|---|---:|---:|
| `list_agents` | 0 | **141** |
| `run_agent_on_pr` | 4 | **395** |
| `get_findings` | 5 | **430** |
| `get_conventions` | 3 | **277** |
| `get_blast_radius` | 2 | **155** |
| **Total `tools/list` payload** | | **1,400** |

Enforced budget, asserted in `test/token-budget.test.ts` so it cannot drift:
**≤ 1,600 total and ≤ 450 per tool**. The bulk above the descriptions is the
JSON Schema each `outputSchema` compiles to — which the "concise structured
response" principle requires, and which roughly doubles a tool definition.

Two free savings are already taken: `list_agents` declares **no `inputSchema`**
(cheaper than an empty object schema) and `get_blast_radius` declares **no
`outputSchema`** (a stub returning a fixed message needs none).

If this ever goes over budget, **do not reword the descriptions** — they are
verbatim from the approved plan and were chosen for their effect on
tool-selection accuracy. The plan carries an ordered trim list, and choosing
from it is the maintainer's call.

## Verifying it by hand

```bash
# 1. API up, DB seeded (acme/payments-api, PR #482, the built-in agents)
./scripts/dev.sh

# 2. Inspector against the source entrypoint
cd mcp && npx @modelcontextprotocol/inspector npx tsx src/index.ts
```

In the Inspector, all five tools should list. Then:

| Call | Expect |
|---|---|
| `list_agents` | the seeded agent names appear |
| `get_conventions {repo:"acme/payments-api"}` | rules with `evidence_path` / `evidence_line`, or the "never extracted" guidance |
| `run_agent_on_pr {repo:"acme/payments-api", pr:482, agent:"Security Reviewer"}` | blocks, then returns a verdict and findings |
| `get_findings {repo:"acme/payments-api", pr:482}` | `{ reviews: [ … ], total_findings: N }`, without re-running |
| `get_blast_radius {repo:"acme/payments-api", pr:482}` | `{ status:"ok", symbols: [ … ] }`, or `not_indexed` |

Error paths worth exercising: stop the API (every tool returns the "not
reachable" message) and pass a bad agent name (`agent not found — call
list_agents`, with the configured names listed).

Finally, restart your MCP host and check the server's real context cost — it
should match the 1,400 measured above.

### stdout purity check

```bash
cd mcp
rg -n 'console\.log|process\.stdout\.write' src        # must print nothing
npm run --silent start < /dev/null | wc -c             # must print 0
```

## Tests

```bash
npm run typecheck    # this IS the build — the package emits no JS
npm test             # 119 tests, hermetic
```

Everything runs against a **stub `DevDigestApi`** injected as a plain object —
no `fetch` mocking, no API, no DB, no Docker, and no `*.it.test.ts` in this
package. That is the payoff of `ports.ts`: if a test here ever needs a live
dependency, a boundary has leaked.

| File | Ring | Asserts |
|---|---|---|
| `shape.test.ts` | domain | field selection, `detail`, truncation, severity ordering, review-list aggregation |
| `config.test.ts` | composition root | env defaults, trailing-slash stripping, invalid-URL rejection |
| `errors.test.ts` | domain | the exact message text per failure mode |
| `resolve.test.ts` | application | resolution + every miss; repo/agent cached, PRs not, misses never |
| `tools.test.ts` | application | each tool end-to-end, incl. polling, `failed`/`cancelled`, and the 5-minute timeout under fake timers |
| `list-agents.test.ts` | application | `system_prompt` appears nowhere; disabled agents returned with the flag |
| `token-budget.test.ts` | presentation | the real wire payload: 5 tools, annotations, flat args, token budget |

## `get_blast_radius` — how it is wired

The tool is **implemented**. It was once registered-but-stubbed as a deliberate
exercise; that stub is gone. The path through the rings, for reference when
changing it:

1. **Port** — `getBlast(pullId: string): Promise<ApiBlast>` on `DevDigestApi`
   (`src/ports.ts`), with a narrow zod-4 schema over only the fields shaped
   below. It does **not** import the zod-3 `PrBlast` contract from `server/`.
2. **Adapter** — one `this.#request('GET', `/pulls/${id}/blast`, …)` line in
   `src/adapters/http-api.ts`, still the only file in the package calling
   `fetch`.
3. **Stub** — `StubApi` in `test/stub-api.ts`, plus the `blast()` fixture.
4. **Shape** — `shapeBlast()` in `src/shape.ts` makes the token decisions:
   `PrBlast` is large, so symbols cap at `MAX_BLAST_SYMBOLS` (10), callers at
   `MAX_BLAST_CALLERS` (5) and collapse to `path:line` strings.
5. **Tool** — `src/tools/get-blast-radius.ts`: `resolveRepo` → `resolvePull` →
   `api.getBlast` → `shapeBlast`, reusing `resolve.ts` rather than re-deriving
   ids.
6. **Registration** — `src/server.ts`, with `readOnlyHint: true`.

**It deliberately declares no `outputSchema`.** The shaped payload is small and
mostly free-form strings, while an `outputSchema` compiles to JSON Schema and
costs 150–250 tokens on *every* turn — more than the tool's own description. The
description carries the selection signal instead. `test/token-budget.test.ts`
asserts the absence so it cannot drift back in; adding one would need roughly
200 tokens of the **200** currently free against the 1,600 ceiling, so measure
before assuming it fits.

`repo_intel.getBlastRadius` only returns `factsByFile` on the persistent-index
path — see `server/INSIGHTS.md` before deciding which fields are reliably
populated.
