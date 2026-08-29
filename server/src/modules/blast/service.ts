import type { BlastRadius, PrHistoryItem } from '@devdigest/shared';
import type { Container } from '../../platform/container.js';
import { NotFoundError } from '../../platform/errors.js';
import { BlastRepository } from './repository.js';
import { toBlastRadius, toHistoryItems } from './helpers.js';
import { MAX_PRIOR_PRS } from './constants.js';

/**
 * Blast radius for one PR — what the changed symbols reach.
 *
 * This module is a CONSUMER of the repo-intel facade, not part of it: it turns
 * `repoIntel.getBlastRadius`'s internal result into the public contract and
 * joins on the prior-PR overlap. All of it is deterministic; no model is called.
 *
 * An unindexed or partially indexed repo is a normal outcome, not an error. The
 * facade already degrades to empty arrays rather than throwing, so the response
 * is a well-formed empty blast radius and the UI shows an empty state.
 */
export interface PrBlast {
  blast: BlastRadius;
  history: PrHistoryItem[];
}

/** Minimal structured-log sink, satisfied by Fastify's `req.log.debug`. */
export type BlastLogger = (obj: Record<string, unknown>, msg: string) => void;

export class BlastService {
  private repo: BlastRepository;

  constructor(private container: Container) {
    this.repo = new BlastRepository(container.db);
  }

  async getForPull(workspaceId: string, prId: string, log?: BlastLogger): Promise<PrBlast> {
    const found = await this.repo.getPullWithRepo(workspaceId, prId);
    if (!found) throw new NotFoundError('Pull request not found');

    const paths = await this.repo.changedPaths(prId);
    // getIndexState never throws (it synthesises a degraded row when the repo
    // was never indexed), so it needs no separate error handling.
    const [result, state, prior] = await Promise.all([
      this.container.repoIntel.getBlastRadius(found.repo.id, paths),
      this.container.repoIntel.getIndexState(found.repo.id),
      this.repo.priorPrsTouching(found.repo.id, prId, paths, MAX_PRIOR_PRS),
    ]);

    const blast = toBlastRadius(result, state);
    // One line, so "this request read the index rather than re-parsing the
    // repo" is checkable in the logs instead of taken on faith.
    log?.(
      {
        source: 'index',
        indexStatus: blast.index.status,
        symbols: blast.changed_symbols.length,
        callers: result.callers.length,
        reached: Object.keys(result.reachedFiles ?? {}).length,
      },
      'blast radius served',
    );

    return { blast, history: toHistoryItems(prior) };
  }
}
