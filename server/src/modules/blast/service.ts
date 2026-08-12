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

export class BlastService {
  private repo: BlastRepository;

  constructor(private container: Container) {
    this.repo = new BlastRepository(container.db);
  }

  async getForPull(workspaceId: string, prId: string): Promise<PrBlast> {
    const found = await this.repo.getPullWithRepo(workspaceId, prId);
    if (!found) throw new NotFoundError('Pull request not found');

    const paths = await this.repo.changedPaths(prId);
    const [result, prior] = await Promise.all([
      this.container.repoIntel.getBlastRadius(found.repo.id, paths),
      this.repo.priorPrsTouching(found.repo.id, prId, paths, MAX_PRIOR_PRS),
    ]);

    return { blast: toBlastRadius(result), history: toHistoryItems(prior) };
  }
}
