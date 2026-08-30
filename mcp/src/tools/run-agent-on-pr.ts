import {
  reviewDidNotStart,
  runEndedBadly,
  runProducedNoReview,
  STILL_RUNNING_MESSAGE,
} from '../errors.js';
import type { ApiRunSummary, ToolContext } from '../ports.js';
import { resolveAgent, resolvePull, resolveRepo } from '../resolve.js';
import { DEFAULT_MAX_FINDINGS, fail, ok, shapeReview, type ToolResult } from '../shape.js';

export interface RunAgentOnPrArgs {
  repo: string;
  pr: number;
  agent: string;
  max_findings?: number;
}

/** Poll cadence for `GET /pulls/:id/runs`. */
export const DEFAULT_POLL_INTERVAL_MS = 2_000;

/** How long to block before handing back a next step instead of a result. */
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000;

export interface RunAgentOnPrOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
  /** Injectable purely so tests can drive the loop without real time passing. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * APPLICATION ring — `run_agent_on_pr`, the one tool that writes.
 *
 * This is design principle #1 (*result, not operation*) made concrete: start
 * the run, wait for it, fetch the findings, return them — one call, one result,
 * no polling loop invented by the model.
 *
 * **Why HTTP polling and not SSE.** `container.runBus` is a module-level
 * singleton in the API process, so a separate stdio process can only reach it
 * through `/runs/:id/events`. That would add a streaming parser for no benefit
 * when the tool's contract is a single blocking result anyway.
 *
 * **Why the timeout returns a result instead of throwing.** Runs execute
 * sequentially per agent and a 13m40s outlier is on record for this system. A
 * tool that hangs is worse than one that hands back the next step.
 */
export async function runAgentOnPr(
  ctx: ToolContext,
  args: RunAgentOnPrArgs,
  options: RunAgentOnPrOptions = {},
): Promise<ToolResult> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep = options.sleep ?? realSleep;

  // Resolution order is deliberate: repo and agent are cached and cheap, while
  // `GET /repos/:id/pulls` triggers a GitHub sync that takes seconds. Failing on
  // a mistyped agent name before paying for that sync is worth the ordering.
  const repo = await resolveRepo(ctx, args.repo);
  const agent = await resolveAgent(ctx, args.agent);
  const pullId = await resolvePull(ctx, repo, args.pr);

  const started = await ctx.api.startReview(pullId, agent.id);
  const target = started.runs[0];
  if (!target) return fail(reviewDidNotStart(agent.name));
  const runId = target.run_id;

  const deadline = Date.now() + timeoutMs;
  let terminal: ApiRunSummary | undefined;

  for (;;) {
    const runs = await ctx.api.listRuns(pullId);
    const current = runs.find((r) => r.run_id === runId);

    // A null `status` is treated as still-running rather than as an error: the
    // column is nullable and a row can be observed mid-write.
    if (current && current.status !== null && current.status !== 'running') {
      terminal = current;
      break;
    }

    if (Date.now() >= deadline) {
      return ok({ status: 'still_running', run_id: runId, message: STILL_RUNNING_MESSAGE });
    }
    await sleep(pollIntervalMs);
  }

  if (terminal.status !== 'done') {
    // The operation genuinely failed, so this is `isError: true` — but the
    // structured payload still travels, because the run id is what the user
    // needs to look the failure up in the studio.
    return {
      ...fail(runEndedBadly(terminal.status ?? 'unknown', terminal.error)),
      structuredContent: {
        status: terminal.status ?? 'unknown',
        run_id: runId,
        message: runEndedBadly(terminal.status ?? 'unknown', terminal.error),
      },
    };
  }

  const reviews = await ctx.api.listReviews(pullId);
  // `run_id` is nullable on the contract — guard before comparing.
  const review = reviews.find(
    (r) => r.kind === 'review' && r.run_id !== null && r.run_id === runId,
  );

  if (!review) {
    return ok({ status: 'done', run_id: runId, message: runProducedNoReview(runId) });
  }

  return ok({
    status: 'done',
    run_id: runId,
    // `detail` is intentionally absent: `rationale` is markdown and frequently
    // long, and it is available on demand via `get_findings({ detail: true })`.
    ...shapeReview(review, { max: args.max_findings ?? DEFAULT_MAX_FINDINGS }),
  });
}
