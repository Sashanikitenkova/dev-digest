import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';
import type { PrRiskBriefPayload } from '../../db/schema/reviews.js';
import type { PullRow } from '../../db/rows.js';

/**
 * Brief data-access. The ONLY layer in this module touching `pr_brief`.
 *
 * Two repositories owning one table is how two mappers silently drift apart,
 * so nothing else writes this table and this repository reads nothing else's:
 * intent, blast, risks and project context are reached through their own
 * services, never through their tables.
 *
 * It does read the PR + its repo row directly, which is the same house rule
 * the intent repository follows: a plain workspace-scoped row read is not
 * another module's business logic.
 */

export type PrBriefRow = typeof t.prBrief.$inferSelect;
export type RepoRow = typeof t.repos.$inferSelect;

/** A PR resolved together with its repo, already scoped to the workspace. */
export interface PullWithRepo {
  pull: PullRow;
  repo: RepoRow;
}

/**
 * The `pr_brief.json` payload, re-exported from the schema layer so callers get
 * the row shape from the repository that owns the table rather than importing
 * `db/schema` themselves — the same rule `db/rows.ts` states for row types.
 * Only this file may reach the schema for this domain.
 */
export type BriefPayload = PrRiskBriefPayload;

/** Everything one generation writes. `prId` is the conflict target (the PK). */
export interface UpsertBrief {
  json: BriefPayload;
  headSha: string;
  provider: string;
  model: string;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
}

/**
 * The outcome of a guarded write: either the row that was written, or the head
 * SHA the pull request actually carries now, so the caller can decide what the
 * requester should get instead.
 */
export type GuardedUpsert =
  | { written: true; row: PrBriefRow }
  | { written: false; currentHeadSha: string | null };

export class BriefRepository {
  constructor(private db: Db) {}

  /**
   * Workspace-scoped PR guard: resolves the PR and its repo in one go, or
   * `undefined` when the PR does not exist IN THIS WORKSPACE (the service
   * turns that into a 404 — never a cross-tenant read).
   */
  async getPullWithRepo(workspaceId: string, prId: string): Promise<PullWithRepo | undefined> {
    const [row] = await this.db
      .select({ pull: t.pullRequests, repo: t.repos })
      .from(t.pullRequests)
      .innerJoin(t.repos, eq(t.repos.id, t.pullRequests.repoId))
      .where(and(eq(t.pullRequests.workspaceId, workspaceId), eq(t.pullRequests.id, prId)));
    return row;
  }

  async getByPr(prId: string): Promise<PrBriefRow | undefined> {
    const [row] = await this.db.select().from(t.prBrief).where(eq(t.prBrief.prId, prId));
    return row;
  }

  /**
   * Store a brief, but ONLY if the pull request still carries the head SHA the
   * generation started from.
   *
   * A generation takes tens of seconds. If the PR is pushed to in the meantime,
   * writing anyway would clobber a brief for the NEW head with one computed
   * from the old one — a lost update, and the reader would have no way to tell.
   *
   * The `FOR UPDATE` is the transaction's FIRST statement, and it is what makes
   * this safe. Wrapping the read and the write in a transaction alone does not:
   * under READ COMMITTED the read sees the snapshot from before a concurrent
   * head update committed, so the comparison passes on stale data and the write
   * lands anyway. A whole-row replace does not help either — it prevents
   * duplicate rows, which was never the problem here. Locking the OWNER row
   * (the pull request) serializes generations for THIS pull request while
   * leaving other pull requests fully parallel; the same shape
   * `ContextRepository.replace` uses.
   *
   * One row per PR: `onConflictDoUpdate` on the primary key, with
   * `generatedAt` set explicitly because the column default only applies on
   * insert.
   */
  async upsertIfHeadUnchanged(
    prId: string,
    expectedHeadSha: string,
    values: UpsertBrief,
  ): Promise<GuardedUpsert> {
    return this.db.transaction(async (tx): Promise<GuardedUpsert> => {
      const [locked] = await tx
        .select({ headSha: t.pullRequests.headSha })
        .from(t.pullRequests)
        .where(eq(t.pullRequests.id, prId))
        .for('update');

      // A missing row means the PR was deleted mid-generation; treat it the
      // same as a moved head — discard, do not resurrect it with a brief.
      const currentHeadSha = locked?.headSha ?? null;
      if (currentHeadSha !== expectedHeadSha) return { written: false, currentHeadSha };

      const set = {
        json: values.json,
        headSha: values.headSha,
        provider: values.provider,
        model: values.model,
        tokensIn: values.tokensIn,
        tokensOut: values.tokensOut,
        costUsd: values.costUsd,
        generatedAt: new Date(),
      };
      const [row] = await tx
        .insert(t.prBrief)
        .values({ prId, ...set })
        .onConflictDoUpdate({ target: t.prBrief.prId, set })
        .returning();
      return { written: true, row: row! };
    });
  }
}
