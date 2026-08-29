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

## Starting it — opt-in, never automatic

This server is **deliberately not auto-started.** Two things make that true:

1. **`scripts/dev.sh` never touches it.** The dev stack brings up Postgres, the
   API and the web app — nothing else. An MCP stdio server is spawned by the
   *host* over a pipe, so launching one from `dev.sh` would leave a process with
   nothing attached to its stdin.
2. **Its config is `mcp/devdigest.mcp.json`, not `.mcp.json`.** That filename is
   on purpose. A `.mcp.json` at the repo root is auto-discovered by Claude Code
   and would connect on *every* session in this repo. Under this name, nothing
   finds it unless you ask.

### Launch a session with it

From the **repo root** (the paths inside the config are relative):

```bash
claude --mcp-config mcp/devdigest.mcp.json
```

To load *only* this server and ignore every other MCP config you have:

```bash
claude --strict-mcp-config --mcp-config mcp/devdigest.mcp.json
```

A plain `claude` in this repo has no devdigest server at all. Verify either way
with `/mcp` inside the session.

> **Why a launch flag rather than the `/mcp` toggle?** The toggle's on/off state
> is stored per-project in `~/.claude.json` — invisible in the repo, not shared
> with anyone, and easy to forget which way you left it. A flag has no hidden
> state: the server exists exactly when you asked for it.

### The config

`mcp/devdigest.mcp.json`:

```json
{
  "mcpServers": {
    "devdigest": {
      "command": "npm",
      "args": ["--prefix", "./mcp", "run", "--silent", "start"],
      "env": {
        "DEVDIGEST_API_BASE": "http://localhost:3001",
        "DEVDIGEST_WEB_BASE": "http://localhost:3000"
      }
    }
  }
}
```

Both env vars are optional; the values above are also the built-in defaults.
`DEVDIGEST_WEB_BASE` is used only inside error messages that point you at the
studio.

> ⚠️ **`--silent` is not optional.** Measured on this package: `npm run start`
> writes **50 bytes** of its own `> @devdigest/mcp@0.0.0 start` banner to stdout
> before the server starts. stdout is the JSON-RPC frame channel, so those 50
> bytes corrupt the first frame and the host reports a contentless "server failed
> to connect". With `--silent`, stdout is **0 bytes** until the first real frame.

> ⚠️ **Relative `--prefix`.** `./mcp` assumes you launch from the repo root. If
> you start Claude Code from elsewhere, substitute an absolute path.

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

Returns the verdict and findings from the latest completed review of a pull
request, **without running a new one**.

| Argument | Type | Meaning |
|---|---|---|
| `repo` | `string` | Repository as `"owner/name"`. |
| `pr` | `number` | Pull request number. |
| `agent` | `string?` | Only this agent's review. Defaults to the most recent by any agent. |
| `detail` | `boolean?` | Include each finding's full `rationale` (and `confidence`). Defaults to `false`. |
| `max_findings` | `number?` | Most severe first. Defaults to 20. |

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

### `get_blast_radius` — read-only, **deliberately a stub**

Takes `repo` and `pr`, makes no API call, never throws, and returns
`{ implemented: false, message }`. See "Finishing `get_blast_radius`" below.

## Measured token cost

Every tool's name, description and JSON Schema is injected at session start and
re-sent on **every turn**, so this is a real recurring tax. `npm test` measures
it against the actual `tools/list` wire payload (`js-tiktoken`, `cl100k_base`,
over a live `InMemoryTransport` + `Client.listTools()`), not an estimate:

| Tool | Params | **Measured tokens** |
|---|---:|---:|
| `list_agents` | 0 | **141** |
| `run_agent_on_pr` | 4 | **395** |
| `get_findings` | 5 | **403** |
| `get_conventions` | 3 | **277** |
| `get_blast_radius` | 2 | **136** |
| **Total `tools/list` payload** | | **1,354** |

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
| `get_findings {repo:"acme/payments-api", pr:482}` | the same result, without re-running |
| `get_blast_radius {repo:"acme/payments-api", pr:482}` | `{ implemented: false, message: … }` |

Error paths worth exercising: stop the API (every tool returns the "not
reachable" message) and pass a bad agent name (`agent not found — call
list_agents`, with the configured names listed).

Finally, restart your MCP host and check the server's real context cost — it
should match the 1,354 measured above.

### stdout purity check

```bash
cd mcp
rg -n 'console\.log|process\.stdout\.write' src        # must print nothing
npm run --silent start < /dev/null | wc -c             # must print 0
```

## Tests

```bash
npm run typecheck    # this IS the build — the package emits no JS
npm test             # 103 tests, hermetic
```

Everything runs against a **stub `DevDigestApi`** injected as a plain object —
no `fetch` mocking, no API, no DB, no Docker, and no `*.it.test.ts` in this
package. That is the payoff of `ports.ts`: if a test here ever needs a live
dependency, a boundary has leaked.

| File | Ring | Asserts |
|---|---|---|
| `shape.test.ts` | domain | field selection, `detail`, truncation, severity ordering |
| `errors.test.ts` | domain | the exact message text per failure mode |
| `resolve.test.ts` | application | resolution + every miss; repo/agent cached, PRs not, misses never |
| `tools.test.ts` | application | each tool end-to-end, incl. polling, `failed`/`cancelled`, and the 5-minute timeout under fake timers |
| `list-agents.test.ts` | application | `system_prompt` appears nowhere; disabled agents returned with the flag |
| `token-budget.test.ts` | presentation | the real wire payload: 5 tools, annotations, flat args, token budget |

## Finishing `get_blast_radius` (the homework)

The tool ships **registered but not wired**, so the five-tool shape holds while
the implementation stays as an exercise. It currently returns:

```
Blast radius is not wired up yet. The backend already implements it at GET /pulls/{id}/blast, which returns changed_symbols, downstream callers, impacted_endpoints, impacted_crons and prior-PR history.
```

The backend endpoint already works. To finish it:

1. **Port** — add `getBlast(pullId: string): Promise<ApiBlast>` to `DevDigestApi`
   in `src/ports.ts`, with a narrow zod-4 schema over just the fields you will
   return. Do not import the zod-3 `PrBlast` contract from `server/`.
2. **Adapter** — implement it in `src/adapters/http-api.ts` as one more
   `this.#request('GET', \`/pulls/${id}/blast\`, …)` line. This stays the only
   file in the package that calls `fetch`.
3. **Stub** — add the method to `StubApi` in `test/stub-api.ts` so the existing
   suite keeps compiling.
4. **Shape** — add a `shapeBlast()` to `src/shape.ts`. This is where the token
   decisions belong: `PrBlast` is large, so select fields and truncate the
   caller lists rather than passing the DTO through.
5. **Tool** — replace the body of `src/tools/get-blast-radius.ts` with
   `resolveRepo` → `resolvePull` → `api.getBlast` → `shapeBlast`. Reuse
   `resolve.ts`; do not re-derive ids.
6. **Registration** — in `src/server.ts`, rewrite the description (dropping the
   `"Not implemented yet."` prefix, which exists purely to stop the model
   selecting a dead tool) and add an `outputSchema`.
7. **Budget** — re-run `npm test`. Adding an `outputSchema` here will cost
   roughly 150–250 tokens; the total has **246 tokens of headroom** against the
   1,600 ceiling, so measure before assuming it fits.

`repo_intel.getBlastRadius` only returns `factsByFile` on the persistent-index
path — see `server/INSIGHTS.md` before deciding which fields are reliably
populated.
