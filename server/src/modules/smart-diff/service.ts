import { SmartDiff } from '@devdigest/shared';
import type { Container } from '../../platform/container.js';
import { NotFoundError } from '../../platform/errors.js';
import { SmartDiffRepository } from './repository.js';
import { buildSmartDiff } from './helpers.js';

/**
 * Smart Diff for one PR — the changed files sorted into core / wiring /
 * boilerplate so a reviewer reads business logic before generated output.
 *
 * Entirely deterministic: a path-pattern classifier over already-imported
 * `pr_files` rows, joined with the findings of the latest review round. NO
 * MODEL IS CALLED HERE, and none may be added — the whole value of the feature
 * is that it works the instant a PR is imported, before any review has run.
 *
 * A PR with no review yet is the normal first state, not an error: the groups
 * are returned exactly as they would be later, with empty `finding_lines`.
 */
export class SmartDiffService {
  private repo: SmartDiffRepository;

  constructor(container: Container) {
    this.repo = new SmartDiffRepository(container.db);
  }

  async getForPull(workspaceId: string, prId: string): Promise<SmartDiff> {
    const found = await this.repo.getPullWithRepo(workspaceId, prId);
    if (!found) throw new NotFoundError('Pull request not found');

    const files = await this.repo.changedFiles(prId);

    // Prefer the latest review ROUND (all agents from one Run Review click).
    // Seeded/imported reviews predate run tracking and carry no run_id, so a PR
    // with no round at all falls back to its newest review row.
    //
    // The fallback keys off the round EXISTING, not off it having findings: a
    // round that ran and found nothing is a clean diff, and quietly replacing
    // that with an older review's findings would show issues the newest review
    // already cleared.
    const roundFindings = await this.repo.latestRoundFindings(prId);
    const findings = roundFindings ?? (await this.repo.newestReviewFindings(prId));

    // Parse, don't just cast: this is the contract boundary, and a drifted
    // shape should fail here rather than in the browser.
    return SmartDiff.parse(buildSmartDiff(files, findings));
  }
}
