import { BLAST_NOT_INDEXED_MESSAGE } from '../errors.js';
import type { ToolContext } from '../ports.js';
import { resolvePull, resolveRepo } from '../resolve.js';
import { ok, shapeBlast, type ToolResult } from '../shape.js';

export interface GetBlastRadiusArgs {
  repo: string;
  pr: number;
}

/**
 * APPLICATION ring — `get_blast_radius`.
 *
 * Answers "what else could this diff affect?" from the repo index: the symbols
 * the PR changed, who calls them, and which endpoints or crons sit downstream.
 * No model is involved on either side of the wire — the server derives every
 * node and edge from `symbols` / `references` / `file_edges`, and this tool
 * only shapes them.
 *
 * An unindexed repo returns `isError: false`. "Not indexed yet" is a known
 * state of a healthy system; flagging it as an error teaches the model to
 * distrust the rest of the server. It is reported as `not_indexed` rather than
 * as an empty map, because those two must never collapse into one answer.
 */
export async function getBlastRadius(
  ctx: ToolContext,
  args: GetBlastRadiusArgs,
): Promise<ToolResult> {
  const repo = await resolveRepo(ctx, args.repo);
  const pullId = await resolvePull(ctx, repo, args.pr);

  const payload = await ctx.api.getBlast(pullId);

  if (payload.blast.index.status === 'missing') {
    return ok({ status: 'not_indexed', message: BLAST_NOT_INDEXED_MESSAGE });
  }

  return ok({ status: 'ok', ...shapeBlast(payload) });
}
