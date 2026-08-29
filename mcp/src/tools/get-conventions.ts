import { NO_CONVENTIONS_MESSAGE } from '../errors.js';
import type { ToolContext } from '../ports.js';
import { resolveRepo } from '../resolve.js';
import { DEFAULT_MAX_CONVENTIONS, ok, shapeConventions, type ToolResult } from '../shape.js';

export interface GetConventionsArgs {
  repo: string;
  status?: 'accepted' | 'pending' | 'rejected';
  max?: number;
}

/**
 * APPLICATION ring — `get_conventions`.
 *
 * Convention rows are precomputed by the extractor and never lazily produced on
 * read, so an empty list means "never extracted", not "this repo has no
 * conventions". Returning a bare `[]` would read as a settled negative answer;
 * the guidance message tells the agent how to make the data exist.
 *
 * `isError` stays `false` for both empty cases — nothing has gone wrong.
 */
export async function getConventions(
  ctx: ToolContext,
  args: GetConventionsArgs,
): Promise<ToolResult> {
  const repo = await resolveRepo(ctx, args.repo);
  const all = await ctx.api.listConventions(repo.id);

  const status = args.status ?? 'accepted';
  const conventions = shapeConventions(all, {
    status,
    max: args.max ?? DEFAULT_MAX_CONVENTIONS,
  });

  if (all.length === 0) {
    return ok({ conventions: [], message: NO_CONVENTIONS_MESSAGE });
  }
  if (conventions.length === 0) {
    // Extraction HAS run — the status filter is what emptied the list. Saying
    // "never extracted" here would send the agent down the wrong path.
    return ok({
      conventions: [],
      message: `${all.length} conventions were extracted for "${repo.fullName}", but none have status "${status}". Call get_conventions again with a different status, or triage them in the DevDigest UI at ${ctx.webBaseUrl}.`,
    });
  }

  return ok({ conventions });
}
