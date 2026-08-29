import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { DevDigestToolError, unexpectedFailure } from './errors.js';
import type { ToolContext } from './ports.js';
import { fail, type ToolResult } from './shape.js';
import { getBlastRadius } from './tools/get-blast-radius.js';
import { getConventions } from './tools/get-conventions.js';
import { getFindings } from './tools/get-findings.js';
import { listAgents } from './tools/list-agents.js';
import { runAgentOnPr } from './tools/run-agent-on-pr.js';

/**
 * PRESENTATION ring — schema in → handler → structured result out. No logic.
 *
 * ⚠️ **Every description string in this file is verbatim from the approved
 * plan.** They are the token-budget-critical text: each one is injected at
 * session start and re-sent on every turn, and each was chosen for a specific
 * effect on the model's tool-selection accuracy. Rewording one changes both the
 * context cost and the selection behaviour, so do not "improve" them —
 * `test/token-budget.test.ts` measures the result of this file, not an estimate.
 *
 * The **non-deprecated** `registerTool` overload is used throughout:
 * `inputSchema`/`outputSchema` take whole `z.object({...})` values. The raw
 * `{ field: z.string() }` shape overload is marked `@deprecated` in SDK v2.
 */

// ---- Shared argument schemas (flat scalars only — design principle #2) -----

const RepoArg = z.string().describe('Repository as "owner/name", e.g. "acme/payments-api".');
const PrArg = z.number().int().describe('Pull request number, e.g. 482.');
const MaxFindingsArg = z
  .number()
  .int()
  .optional()
  .describe('Maximum findings to return, most severe first. Defaults to 20.');

// ---- Shared output schemas ------------------------------------------------

/**
 * The concise finding shape. `rationale`/`confidence` are optional because only
 * `get_findings({ detail: true })` populates them — `rationale` is markdown and
 * is the single largest field on a finding.
 */
const FindingOut = z.object({
  severity: z.string(),
  category: z.string(),
  title: z.string(),
  file: z.string(),
  start_line: z.number(),
  end_line: z.number(),
  suggestion: z.string().optional(),
  rationale: z.string().optional(),
  confidence: z.number().optional(),
});

/**
 * Shared by both review-returning tools. Everything past `status` is optional so
 * the same schema covers the real outcomes — done, failed, still running, and
 * nothing-reviewed-yet — without a second schema or a discriminated union.
 */
const ReviewOut = z.object({
  status: z.string(),
  run_id: z.string().optional(),
  verdict: z.string().optional(),
  score: z.number().optional(),
  summary: z.string().optional(),
  agent: z.string().optional(),
  findings_count: z.number().optional(),
  findings: z.array(FindingOut).optional(),
  message: z.string().optional(),
});

/**
 * Builds the MCP server with all five tools registered.
 *
 * Exported separately from the stdio bootstrap so tests can drive it over
 * `InMemoryTransport` without spawning a process — that is what makes
 * `token-budget.test.ts` able to measure the REAL wire payload.
 */
export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: 'devdigest', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );

  // ---- 1. list_agents -----------------------------------------------------
  // Declares NO inputSchema: the tool takes no arguments, and omitting the
  // field is cheaper than advertising an empty object schema.
  server.registerTool(
    'list_agents',
    {
      description:
        'Lists the review agents configured in DevDigest. Call this first to get a valid agent name for run_agent_on_pr.',
      outputSchema: z.object({
        agents: z.array(
          z.object({
            name: z.string(),
            description: z.string(),
            model: z.string(),
            enabled: z.boolean(),
          }),
        ),
      }),
      annotations: { readOnlyHint: true },
    },
    () => guard('list_agents', () => listAgents(ctx)),
  );

  // ---- 2. run_agent_on_pr -------------------------------------------------
  server.registerTool(
    'run_agent_on_pr',
    {
      description:
        'Runs a DevDigest review agent on a pull request and waits for it to finish. Returns the verdict and findings in one call.',
      inputSchema: z.object({
        repo: RepoArg,
        pr: PrArg,
        agent: z.string().describe('Agent name from list_agents.'),
        max_findings: MaxFindingsArg,
      }),
      outputSchema: ReviewOut,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    (args) => guard('run_agent_on_pr', () => runAgentOnPr(ctx, args)),
  );

  // ---- 3. get_findings ----------------------------------------------------
  server.registerTool(
    'get_findings',
    {
      description:
        'Returns the verdict and findings from the latest completed review of a pull request, without running a new one.',
      inputSchema: z.object({
        repo: RepoArg,
        pr: PrArg,
        agent: z
          .string()
          .optional()
          .describe("Only return this agent's review. Defaults to the most recent review by any agent."),
        detail: z
          .boolean()
          .optional()
          .describe("Include each finding's full rationale. Defaults to false."),
        max_findings: MaxFindingsArg,
      }),
      outputSchema: ReviewOut,
      annotations: { readOnlyHint: true },
    },
    (args) => guard('get_findings', () => getFindings(ctx, args)),
  );

  // ---- 4. get_conventions -------------------------------------------------
  server.registerTool(
    'get_conventions',
    {
      description:
        'Returns the coding conventions DevDigest extracted from a repository, each with the file and line that evidences it.',
      inputSchema: z.object({
        repo: RepoArg,
        // Deliberate exception to "don't inline enums": three short literals
        // cost ~10 tokens and never go stale, unlike agent names or repo ids.
        status: z
          .enum(['accepted', 'pending', 'rejected'])
          .optional()
          .describe('Filter by review status: accepted, pending, or rejected. Defaults to accepted.'),
        max: z
          .number()
          .int()
          .optional()
          .describe('Maximum conventions to return, highest confidence first. Defaults to 30.'),
      }),
      outputSchema: z.object({
        conventions: z.array(
          z.object({
            rule: z.string(),
            category: z.string().optional(),
            evidence_path: z.string(),
            evidence_line: z.number().optional(),
            confidence: z.number(),
          }),
        ),
        message: z.string().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    (args) => guard('get_conventions', () => getConventions(ctx, args)),
  );

  // ---- 5. get_blast_radius ------------------------------------------------
  // Still declares NO outputSchema. The shaped payload is small and mostly
  // free-form strings, while an outputSchema compiles to JSON Schema and costs
  // 150-250 tokens on EVERY turn — more than the tool's own description. The
  // description carries the selection signal instead.
  server.registerTool(
    'get_blast_radius',
    {
      description:
        "Returns a pull request's impact map from the repo index: the symbols it changed, which files call them, and the HTTP endpoints and cron jobs downstream. Use it to answer what else a change could affect.",
      inputSchema: z.object({ repo: RepoArg, pr: PrArg }),
      annotations: { readOnlyHint: true },
    },
    (args) => guard('get_blast_radius', () => getBlastRadius(ctx, args)),
  );

  return server;
}

/**
 * Turns any thrown error into a forward-leading `isError: true` result.
 *
 * A `DevDigestToolError` already carries a model-readable sentence, so it is
 * passed through verbatim. Anything else is wrapped — an internal stack trace
 * must never reach the model's context, and it goes to stderr instead.
 */
async function guard(toolName: string, run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof DevDigestToolError) return fail(error.message);
    // stderr only — stdout is the JSON-RPC channel.
    console.error(`[devdigest-mcp] ${toolName} threw:`, error);
    return fail(unexpectedFailure(toolName, error instanceof Error ? error.message : String(error)));
  }
}
