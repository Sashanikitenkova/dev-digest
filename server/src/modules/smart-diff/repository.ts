import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';
import type { PullRow } from '../../db/rows.js';

/**
 * Smart-diff data access. Reads the PR's changed files and the findings of its
 * latest review round — nothing else. No index tables, no external calls.
 *
 * The PR + repo guard is duplicated from the blast repository on purpose: the
 * house rule is that a module never reaches into another module's folder, and a
 * plain workspace-scoped row read is not another module's business logic.
 */

export type RepoRow = typeof t.repos.$inferSelect;

export interface PullWithRepo {
  pull: PullRow;
  repo: RepoRow;
}

/** One changed file, as persisted by the PR import. */
export interface ChangedFileRow {
  path: string;
  additions: number;
  deletions: number;
}

/** The finding fields smart-diff needs — line + severity, keyed by file. */
export interface FindingLineRow {
  file: string;
  startLine: number;
  severity: string;
}

export class SmartDiffRepository {
  constructor(private db: Db) {}

  /** Workspace-scoped PR guard — `undefined` means "not in this workspace" (404). */
  async getPullWithRepo(workspaceId: string, prId: string): Promise<PullWithRepo | undefined> {
    const [row] = await this.db
      .select({ pull: t.pullRequests, repo: t.repos })
      .from(t.pullRequests)
      .innerJoin(t.repos, eq(t.repos.id, t.pullRequests.repoId))
      .where(and(eq(t.pullRequests.workspaceId, workspaceId), eq(t.pullRequests.id, prId)));
    return row;
  }

  /** The PR's changed files — the input to the classifier. */
  async changedFiles(prId: string): Promise<ChangedFileRow[]> {
    const rows = await this.db
      .select({
        path: t.prFiles.path,
        additions: t.prFiles.additions,
        deletions: t.prFiles.deletions,
      })
      .from(t.prFiles)
      .where(eq(t.prFiles.prId, prId));
    return rows.map((r) => ({
      path: r.path,
      additions: r.additions ?? 0,
      deletions: r.deletions ?? 0,
    }));
  }

  /**
   * Findings from the latest review ROUND — every agent queued by one "Run
   * Review" click, not just one agent's pass.
   *
   * A round is identified by the shared `ran_at` on `agent_runs` (ReviewService
   * stamps one timestamp per batch), so the max `ran_at` selects the whole
   * round.
   *
   * Returns `null` — not `[]` — when the PR has no round at all. The two are
   * genuinely different answers: "nobody has reviewed this yet" invites a
   * fallback to an older review, while "the latest review ran and found
   * nothing" must stay empty. Collapsing them would resurrect findings the
   * newest review already cleared.
   */
  async latestRoundFindings(prId: string): Promise<FindingLineRow[] | null> {
    const runs = await this.db
      .select({ id: t.agentRuns.id, ranAt: t.agentRuns.ranAt })
      .from(t.agentRuns)
      .where(eq(t.agentRuns.prId, prId));
    if (runs.length === 0) return null;

    const maxRanAt = Math.max(...runs.map((r) => r.ranAt.getTime()));
    const runIds = runs.filter((r) => r.ranAt.getTime() === maxRanAt).map((r) => r.id);

    const reviews = await this.db
      .select({ id: t.reviews.id })
      .from(t.reviews)
      .where(and(eq(t.reviews.prId, prId), inArray(t.reviews.runId, runIds)));
    // A round whose runs produced no review row at all (every agent failed) is
    // indistinguishable from no round — fall back rather than blank the diff.
    if (reviews.length === 0) return null;

    return this.findingsForReviews(reviews.map((r) => r.id));
  }

  /**
   * Findings of the single newest review row — the fallback for PRs whose
   * reviews predate run tracking (seed data writes reviews with no `run_id`).
   */
  async newestReviewFindings(prId: string): Promise<FindingLineRow[]> {
    const [review] = await this.db
      .select({ id: t.reviews.id })
      .from(t.reviews)
      .where(and(eq(t.reviews.prId, prId), eq(t.reviews.kind, 'review')))
      .orderBy(desc(t.reviews.createdAt))
      .limit(1);
    return review ? this.findingsForReviews([review.id]) : [];
  }

  private async findingsForReviews(reviewIds: string[]): Promise<FindingLineRow[]> {
    if (reviewIds.length === 0) return [];
    return this.db
      .select({
        file: t.findings.file,
        startLine: t.findings.startLine,
        severity: t.findings.severity,
      })
      .from(t.findings)
      .where(inArray(t.findings.reviewId, reviewIds));
  }
}
