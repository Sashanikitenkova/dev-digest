import type { Risks } from '@devdigest/shared';
import type { Container } from '../../platform/container.js';
import { NotFoundError } from '../../platform/errors.js';
import { RisksRepository } from './repository.js';
import { scanRisks } from './helpers.js';

/**
 * Risk areas for one PR — a deterministic scan of the changed files.
 *
 * No model, no cost, no persistence: the answer is a pure function of the PR's
 * `pr_files` rows, so it is recomputed per request rather than cached and left
 * to go stale when the PR is re-imported. The `risk_brief` feature model exists
 * in the registry for a future inferential pass; this service deliberately does
 * not call it, so the card can never invent a risk the diff does not show.
 */
export class RisksService {
  private repo: RisksRepository;

  constructor(container: Container) {
    this.repo = new RisksRepository(container.db);
  }

  async getForPull(workspaceId: string, prId: string): Promise<Risks> {
    if (!(await this.repo.prExists(workspaceId, prId))) {
      throw new NotFoundError('Pull request not found');
    }
    return { risks: scanRisks(await this.repo.changedFiles(prId)) };
  }
}
