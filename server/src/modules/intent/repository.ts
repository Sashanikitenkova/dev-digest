import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';
import type { IntentSourceRow } from '../../db/schema/reviews.js';
import type { PullRow } from '../../db/rows.js';

/**
 * Intent data-access. The ONLY layer touching `pr_intent`.
 *
 * The table used to be reachable through `reviews/repository/pull.repo.ts`
 * (`upsertIntent`/`getIntent`, never called by anything); those are deleted in
 * favour of this repository, because two repositories owning one table is how
 * the two mappers silently drift apart.
 *
 * It also reads the PR + its repo row directly — the same house rule the
 * conventions repository follows: a module never reaches into another module's
 * folder, and a plain workspace-scoped row read is not another module's
 * business logic.
 */

export type PrIntentRow = typeof t.prIntent.$inferSelect;
export type RepoRow = typeof t.repos.$inferSelect;

/** A PR resolved together with its repo, already scoped to the workspace. */
export interface PullWithRepo {
  pull: PullRow;
  repo: RepoRow;
}

/** Everything one detection writes. `prId` is the conflict target (the PK). */
export interface UpsertIntent {
  prId: string;
  intent: string;
  inScope: string[];
  outOfScope: string[];
  headSha: string;
  confidence: number;
  confidenceLevel: 'low' | 'medium' | 'high';
  sources: IntentSourceRow[];
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
}

export class IntentRepository {
  constructor(private db: Db) {}

  async getByPr(prId: string): Promise<PrIntentRow | undefined> {
    const [row] = await this.db.select().from(t.prIntent).where(eq(t.prIntent.prId, prId));
    return row;
  }

  /**
   * Workspace-scoped PR guard: resolves the PR and its repo in one go, or
   * `undefined` when the PR does not exist IN THIS WORKSPACE (the route turns
   * that into a 404 — never a cross-tenant read).
   */
  async getPullWithRepo(workspaceId: string, prId: string): Promise<PullWithRepo | undefined> {
    const [row] = await this.db
      .select({ pull: t.pullRequests, repo: t.repos })
      .from(t.pullRequests)
      .innerJoin(t.repos, eq(t.repos.id, t.pullRequests.repoId))
      .where(and(eq(t.pullRequests.workspaceId, workspaceId), eq(t.pullRequests.id, prId)));
    return row;
  }

  /**
   * One row per PR: a re-detect (new head sha or a manual re-run) overwrites in
   * place, so `pr_intent` never accumulates history. `generated_at` is bumped
   * explicitly because the column default only applies on insert.
   */
  async upsert(values: UpsertIntent): Promise<PrIntentRow> {
    const set = {
      intent: values.intent,
      inScope: values.inScope,
      outOfScope: values.outOfScope,
      headSha: values.headSha,
      confidence: values.confidence,
      confidenceLevel: values.confidenceLevel,
      sources: values.sources,
      provider: values.provider,
      model: values.model,
      tokensIn: values.tokensIn,
      tokensOut: values.tokensOut,
      costUsd: values.costUsd,
      generatedAt: new Date(),
    };
    const [row] = await this.db
      .insert(t.prIntent)
      .values({ prId: values.prId, ...set })
      .onConflictDoUpdate({ target: t.prIntent.prId, set })
      .returning();
    return row!;
  }
}
