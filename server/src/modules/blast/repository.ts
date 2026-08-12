import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';
import type { PullRow } from '../../db/rows.js';

/**
 * Blast data-access. Reads `pr_files` (the changed-path set) and the prior-PR
 * overlap; the symbol/caller graph itself is NOT read here — that comes from the
 * `repoIntel` facade, which owns the index tables.
 *
 * The PR + repo guard is duplicated from the intent repository on purpose: the
 * house rule is that a module never reaches into another module's folder, and a
 * plain workspace-scoped row read is not another module's business logic.
 */

export type RepoRow = typeof t.repos.$inferSelect;

export interface PullWithRepo {
  pull: PullRow;
  repo: RepoRow;
}

/** A prior PR that touched at least one of the same files. */
export interface PriorPrRow {
  number: number;
  title: string;
  author: string;
  updatedAt: Date | null;
  overlap: string[];
}

export class BlastRepository {
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

  /** The PR's changed paths — the input to the blast query. */
  async changedPaths(prId: string): Promise<string[]> {
    const rows = await this.db
      .select({ path: t.prFiles.path })
      .from(t.prFiles)
      .where(eq(t.prFiles.prId, prId));
    return rows.map((r) => r.path);
  }

  /**
   * Other PRs in the same repo that touched any of `paths`, newest first.
   *
   * Aggregated in SQL rather than by loading every `pr_files` row and grouping in
   * memory: a busy repo has far more file rows than PRs, and only the overlapping
   * paths are ever displayed.
   */
  async priorPrsTouching(
    repoId: string,
    prId: string,
    paths: string[],
    limit: number,
  ): Promise<PriorPrRow[]> {
    if (paths.length === 0) return [];
    return this.db
      .select({
        number: t.pullRequests.number,
        title: t.pullRequests.title,
        author: t.pullRequests.author,
        updatedAt: t.pullRequests.updatedAt,
        overlap: sql<string[]>`array_agg(distinct ${t.prFiles.path})`,
      })
      .from(t.prFiles)
      .innerJoin(t.pullRequests, eq(t.pullRequests.id, t.prFiles.prId))
      .where(
        and(
          eq(t.pullRequests.repoId, repoId),
          ne(t.pullRequests.id, prId),
          inArray(t.prFiles.path, paths),
        ),
      )
      .groupBy(
        t.pullRequests.id,
        t.pullRequests.number,
        t.pullRequests.title,
        t.pullRequests.author,
        t.pullRequests.updatedAt,
      )
      .orderBy(desc(t.pullRequests.updatedAt))
      .limit(limit);
  }
}
