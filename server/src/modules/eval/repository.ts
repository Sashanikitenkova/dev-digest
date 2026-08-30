import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';
import type { EvalSkillSnapshotJson } from '../../db/schema/eval.js';

/**
 * Eval data-access. The ONLY layer in this module touching `eval_cases`,
 * `eval_runs` and `eval_run_batches` — two repositories owning one table is how
 * two mappers silently drift apart.
 *
 * It deliberately never touches `agent_runs`: that table is the observability
 * record of real PR reviews and feeds the run-cost badge and per-agent
 * accept-rate stats, so synthetic replays must not land there (SPEC-03 AC-25).
 */

export type EvalCaseRow = typeof t.evalCases.$inferSelect;
export type EvalRunRow = typeof t.evalRuns.$inferSelect;
export type EvalBatchRow = typeof t.evalRunBatches.$inferSelect;

export type EvalOwner = { workspaceId: string; ownerKind: 'skill' | 'agent'; ownerId: string };

export interface InsertCase extends EvalOwner {
  name: string;
  inputDiff: string;
  inputFiles?: unknown;
  inputMeta?: unknown;
  expectedOutput: unknown;
  notes?: string | null;
  sourceFindingId?: string | null;
}

export interface StartBatch extends EvalOwner {
  agentVersion: number | null;
  systemPrompt: string;
  skillsSnapshot: EvalSkillSnapshotJson[];
  provider: string | null;
  model: string | null;
  tracesTotal: number;
}

export interface InsertRun {
  batchId: string;
  caseId: string;
  actualOutput: unknown;
  pass: boolean;
  recall: number | null;
  precision: number | null;
  citationAccuracy: number | null;
  tp: number;
  fp: number;
  fn: number;
  kept: number;
  dropped: number;
  durationMs: number;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  error: string | null;
}

export interface FinishBatch {
  status: 'done' | 'failed';
  recall: number | null;
  precision: number | null;
  citationAccuracy: number | null;
  tracesPassed: number;
  tracesTotal: number;
  durationMs: number;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  error: string | null;
}

export class EvalRepository {
  constructor(private db: Db) {}

  // ---- cases --------------------------------------------------------------

  async listCases(owner: EvalOwner): Promise<EvalCaseRow[]> {
    return this.db
      .select()
      .from(t.evalCases)
      .where(
        and(
          eq(t.evalCases.workspaceId, owner.workspaceId),
          eq(t.evalCases.ownerKind, owner.ownerKind),
          eq(t.evalCases.ownerId, owner.ownerId),
        ),
      )
      .orderBy(desc(t.evalCases.createdAt));
  }

  async getCase(workspaceId: string, id: string): Promise<EvalCaseRow | undefined> {
    const [row] = await this.db
      .select()
      .from(t.evalCases)
      .where(and(eq(t.evalCases.workspaceId, workspaceId), eq(t.evalCases.id, id)))
      .limit(1);
    return row;
  }

  /**
   * The case already frozen from this finding, if any.
   *
   * Backs the idempotent create (AC-9) and the already-in-set state on the
   * finding card (AC-11) — without it, a second click silently doubles the case.
   */
  async caseForFinding(workspaceId: string, findingId: string): Promise<EvalCaseRow | undefined> {
    const [row] = await this.db
      .select()
      .from(t.evalCases)
      .where(
        and(
          eq(t.evalCases.workspaceId, workspaceId),
          eq(t.evalCases.sourceFindingId, findingId),
        ),
      )
      .limit(1);
    return row;
  }

  /** Which of these findings already have a case — one query, not N. */
  async findingIdsWithCases(workspaceId: string, findingIds: string[]): Promise<string[]> {
    if (findingIds.length === 0) return [];
    const rows = await this.db
      .select({ id: t.evalCases.sourceFindingId })
      .from(t.evalCases)
      .where(
        and(
          eq(t.evalCases.workspaceId, workspaceId),
          inArray(t.evalCases.sourceFindingId, findingIds),
        ),
      );
    return rows.map((r) => r.id).filter((id): id is string => id !== null);
  }

  async insertCase(values: InsertCase): Promise<EvalCaseRow> {
    const [row] = await this.db
      .insert(t.evalCases)
      .values({
        workspaceId: values.workspaceId,
        ownerKind: values.ownerKind,
        ownerId: values.ownerId,
        name: values.name,
        inputDiff: values.inputDiff,
        inputFiles: values.inputFiles ?? null,
        inputMeta: values.inputMeta ?? null,
        expectedOutput: values.expectedOutput as never,
        notes: values.notes ?? null,
        sourceFindingId: values.sourceFindingId ?? null,
      })
      .returning();
    return row!;
  }

  async updateCase(
    workspaceId: string,
    id: string,
    values: Partial<Pick<InsertCase, 'name' | 'inputDiff' | 'expectedOutput' | 'notes'>>,
  ): Promise<EvalCaseRow | undefined> {
    const [row] = await this.db
      .update(t.evalCases)
      .set({
        ...(values.name !== undefined ? { name: values.name } : {}),
        ...(values.inputDiff !== undefined ? { inputDiff: values.inputDiff } : {}),
        ...(values.expectedOutput !== undefined
          ? { expectedOutput: values.expectedOutput as never }
          : {}),
        ...(values.notes !== undefined ? { notes: values.notes } : {}),
      })
      .where(and(eq(t.evalCases.workspaceId, workspaceId), eq(t.evalCases.id, id)))
      .returning();
    return row;
  }

  async deleteCase(workspaceId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(t.evalCases)
      .where(and(eq(t.evalCases.workspaceId, workspaceId), eq(t.evalCases.id, id)))
      .returning({ id: t.evalCases.id });
    return rows.length > 0;
  }

  // ---- batches ------------------------------------------------------------

  async startBatch(values: StartBatch): Promise<EvalBatchRow> {
    const [row] = await this.db
      .insert(t.evalRunBatches)
      .values({
        workspaceId: values.workspaceId,
        ownerKind: values.ownerKind,
        ownerId: values.ownerId,
        status: 'running',
        agentVersion: values.agentVersion,
        systemPrompt: values.systemPrompt,
        skillsSnapshot: values.skillsSnapshot,
        provider: values.provider,
        model: values.model,
        tracesTotal: values.tracesTotal,
      })
      .returning();
    return row!;
  }

  async finishBatch(batchId: string, values: FinishBatch): Promise<void> {
    await this.db
      .update(t.evalRunBatches)
      .set({ ...values, finishedAt: new Date() })
      .where(eq(t.evalRunBatches.id, batchId));
  }

  async getBatch(workspaceId: string, id: string): Promise<EvalBatchRow | undefined> {
    const [row] = await this.db
      .select()
      .from(t.evalRunBatches)
      .where(and(eq(t.evalRunBatches.workspaceId, workspaceId), eq(t.evalRunBatches.id, id)))
      .limit(1);
    return row;
  }

  /** Batch history, newest first. Omit the owner for a workspace-wide feed. */
  async listBatches(
    workspaceId: string,
    owner?: { ownerKind: 'skill' | 'agent'; ownerId: string },
    limit = 20,
  ): Promise<EvalBatchRow[]> {
    const scope = owner
      ? and(
          eq(t.evalRunBatches.workspaceId, workspaceId),
          eq(t.evalRunBatches.ownerKind, owner.ownerKind),
          eq(t.evalRunBatches.ownerId, owner.ownerId),
        )
      : eq(t.evalRunBatches.workspaceId, workspaceId);
    return this.db
      .select()
      .from(t.evalRunBatches)
      .where(scope)
      .orderBy(desc(t.evalRunBatches.startedAt))
      .limit(limit);
  }

  /** Latest terminal batch per owner — the dashboard's agent cards. */
  async latestBatchPerOwner(workspaceId: string): Promise<EvalBatchRow[]> {
    const rows = await this.db
      .select()
      .from(t.evalRunBatches)
      .where(eq(t.evalRunBatches.workspaceId, workspaceId))
      .orderBy(desc(t.evalRunBatches.startedAt));
    const seen = new Set<string>();
    const latest: EvalBatchRow[] = [];
    for (const row of rows) {
      const key = `${row.ownerKind}:${row.ownerId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      latest.push(row);
    }
    return latest;
  }

  // ---- per-case runs ------------------------------------------------------

  async insertRun(values: InsertRun): Promise<EvalRunRow> {
    const [row] = await this.db.insert(t.evalRuns).values(values).returning();
    return row!;
  }

  /** Per-case rows of one batch, joined to their case name for display. */
  async runsForBatch(batchId: string): Promise<{ run: EvalRunRow; caseName: string | null }[]> {
    const rows = await this.db
      .select({ run: t.evalRuns, caseName: t.evalCases.name })
      .from(t.evalRuns)
      .leftJoin(t.evalCases, eq(t.evalRuns.caseId, t.evalCases.id))
      .where(eq(t.evalRuns.batchId, batchId))
      .orderBy(t.evalRuns.ranAt);
    return rows.map((r) => ({ run: r.run, caseName: r.caseName }));
  }

  /** The case ids a batch actually executed — the drift check's input (AC-42). */
  async caseIdsForBatch(batchId: string): Promise<string[]> {
    const rows = await this.db
      .select({ caseId: t.evalRuns.caseId })
      .from(t.evalRuns)
      .where(eq(t.evalRuns.batchId, batchId));
    return rows.map((r) => r.caseId);
  }

  /** The newest run per case for an owner — the "last result" column. */
  async latestRunPerCase(owner: EvalOwner): Promise<Map<string, EvalRunRow>> {
    const rows = await this.db
      .select({ run: t.evalRuns })
      .from(t.evalRuns)
      .innerJoin(t.evalCases, eq(t.evalRuns.caseId, t.evalCases.id))
      .where(
        and(
          eq(t.evalCases.workspaceId, owner.workspaceId),
          eq(t.evalCases.ownerKind, owner.ownerKind),
          eq(t.evalCases.ownerId, owner.ownerId),
        ),
      )
      .orderBy(desc(t.evalRuns.ranAt));
    const latest = new Map<string, EvalRunRow>();
    for (const { run } of rows) if (!latest.has(run.caseId)) latest.set(run.caseId, run);
    return latest;
  }

  async countCases(owner: EvalOwner): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(t.evalCases)
      .where(
        and(
          eq(t.evalCases.workspaceId, owner.workspaceId),
          eq(t.evalCases.ownerKind, owner.ownerKind),
          eq(t.evalCases.ownerId, owner.ownerId),
        ),
      );
    return row?.n ?? 0;
  }
}
