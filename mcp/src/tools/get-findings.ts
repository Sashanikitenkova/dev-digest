import { noReviewYet } from '../errors.js';
import type { ApiReview, ToolContext } from '../ports.js';
import { resolvePull, resolveRepo, resolveAgent } from '../resolve.js';
import { DEFAULT_MAX_FINDINGS, ok, shapeReview, type ToolResult } from '../shape.js';

export interface GetFindingsArgs {
  repo: string;
  pr: number;
  agent?: string;
  detail?: boolean;
  max_findings?: number;
}

/**
 * APPLICATION ring — `get_findings`.
 *
 * Reads `GET /pulls/:id/reviews` (newest first) and takes the newest matching
 * `ReviewDto`. Two nullability traps live here:
 *
 * - `kind` is `'summary' | 'review'` — a multi-agent round also emits a
 *   `summary` roll-up row, so anything that wants "an agent's review" must
 *   select `kind === 'review'` explicitly.
 * - `run_id` and `agent_id` are nullable, so every filter over them needs a
 *   null guard rather than a bare equality test.
 *
 * "No review yet" is `isError: false`: it is a legitimate state of a healthy
 * system, and the message names the tool that fixes it.
 */
export async function getFindings(ctx: ToolContext, args: GetFindingsArgs): Promise<ToolResult> {
  const repo = await resolveRepo(ctx, args.repo);
  const agent = args.agent ? await resolveAgent(ctx, args.agent) : undefined;
  const pullId = await resolvePull(ctx, repo, args.pr);

  const reviews = await ctx.api.listReviews(pullId);
  const latest = pickLatestReview(reviews, agent?.id);

  if (!latest) {
    return ok({
      status: 'no_review',
      message: noReviewYet(repo.fullName, args.pr, agent?.name),
    });
  }

  return ok({
    status: 'ok',
    ...shapeReview(latest, {
      detail: args.detail ?? false,
      max: args.max_findings ?? DEFAULT_MAX_FINDINGS,
    }),
  });
}

/** `listReviews` is newest-first, so the first match is the latest. */
function pickLatestReview(reviews: readonly ApiReview[], agentId?: string): ApiReview | undefined {
  return reviews.find(
    (r) => r.kind === 'review' && (agentId === undefined || (r.agent_id !== null && r.agent_id === agentId)),
  );
}
