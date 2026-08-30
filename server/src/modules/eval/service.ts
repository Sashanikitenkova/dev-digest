import type {
  EvalBatchDetail,
  EvalBatchRecord,
  EvalBatchStart,
  EvalCase,
  EvalCompare,
  EvalDashboard,
  EvalRunRecord,
  EvalTrendPoint,
  EvalOwnerKind,
} from '@devdigest/shared';
import { EvalExpectation as EvalExpectationSchema } from '@devdigest/shared';
import { sliceDiff } from '@devdigest/reviewer-core';
import type { Container } from '../../platform/container.js';
import { AppError, NotFoundError, ValidationError } from '../../platform/errors.js';
import { loadDiff } from '../reviews/diff-loader.js';
import { EvalRepository, type EvalOwner } from './repository.js';
import { EvalRunExecutor, type Logger } from './run-executor.js';
import {
  caseNameFromFinding,
  caseSetMismatch,
  expectationFromFinding,
  metricDelta,
  skillsChanged,
  toEvalBatchRecord,
  toEvalCase,
  toEvalRunRecord,
} from './helpers.js';

/**
 * Eval orchestration (SPEC-03). Owns the logic; the repository owns the tables
 * and `scoring.ts` owns the arithmetic.
 */
export class EvalService {
  private repo: EvalRepository;
  private executor: EvalRunExecutor;

  constructor(private container: Container) {
    this.repo = new EvalRepository(container.db);
    this.executor = new EvalRunExecutor(container, this.repo);
  }

  // ---- cases --------------------------------------------------------------

  async listCases(owner: EvalOwner): Promise<EvalCase[]> {
    const rows = await this.repo.listCases(owner);
    return rows.map(toEvalCase);
  }

  /** The newest per-case result, keyed by case id — the "last result" column. */
  async latestResults(owner: EvalOwner): Promise<Record<string, EvalRunRecord>> {
    const latest = await this.repo.latestRunPerCase(owner);
    const out: Record<string, EvalRunRecord> = {};
    for (const [caseId, run] of latest) out[caseId] = toEvalRunRecord(run);
    return out;
  }

  async findingIdsWithCases(workspaceId: string, findingIds: string[]): Promise<string[]> {
    return this.repo.findingIdsWithCases(workspaceId, findingIds);
  }

  /**
   * Freeze a reviewed finding into an eval case — the one-click path (AC-1).
   *
   * Every rejection below is deliberate rather than a lenient default: a case
   * that cannot be scored is worse than no case, because it reports as a failing
   * trace forever and reads as a real regression in the dashboard.
   */
  async createFromFinding(workspaceId: string, findingId: string): Promise<EvalCase> {
    // Idempotent: the button is clickable again after the first click, and a
    // silent duplicate would double this finding's weight in the metrics (AC-9).
    const existing = await this.repo.caseForFinding(workspaceId, findingId);
    if (existing) return toEvalCase(existing);

    const reviewRepo = this.container.reviewRepo;
    const ctx = await reviewRepo.findingContext(findingId);
    if (!ctx) throw new NotFoundError('Finding not found');
    const { finding, review, pull } = ctx;

    if (pull.workspaceId !== workspaceId) throw new NotFoundError('Finding not found');
    if (!review.agentId) {
      throw new ValidationError(
        'This finding has no agent — an eval case belongs to the agent that produced it.',
      );
    }

    // Throws when the finding carries neither decision (AC-4).
    const expectation = expectationFromFinding(finding);

    const repoRow = await reviewRepo.getRepo(pull.repoId);
    if (!repoRow) throw new NotFoundError('Repository not found');

    const diff = await loadDiff(this.container, reviewRepo, workspaceId, pull, repoRow);
    // Only the finding's own file: a case is a small frozen fixture, not a copy
    // of the whole PR, and a one-file diff keeps the replay cost predictable.
    const inputDiff = sliceDiff(diff, finding.file);
    if (!inputDiff.trim()) {
      throw new ValidationError(
        `No diff hunk for '${finding.file}' in this pull request — an eval case needs the code it asserts against.`,
      );
    }

    const row = await this.repo.insertCase({
      workspaceId,
      ownerKind: 'agent',
      ownerId: review.agentId,
      name: caseNameFromFinding(finding),
      inputDiff,
      expectedOutput: expectation,
      notes: `From finding ${finding.file}:${finding.startLine} on PR #${pull.number}`,
      sourceFindingId: finding.id,
      inputMeta: { pr_number: pull.number, pr_title: pull.title, head_sha: pull.headSha },
    });
    return toEvalCase(row);
  }

  async createCase(
    workspaceId: string,
    input: {
      owner_kind: EvalOwnerKind;
      owner_id: string;
      name: string;
      input_diff: string;
      expected_output: unknown;
      notes?: string | null;
    },
  ): Promise<EvalCase> {
    const expectation = this.validateExpectation(input.expected_output);
    const row = await this.repo.insertCase({
      workspaceId,
      ownerKind: input.owner_kind,
      ownerId: input.owner_id,
      name: input.name,
      inputDiff: input.input_diff,
      expectedOutput: expectation,
      notes: input.notes ?? null,
    });
    return toEvalCase(row);
  }

  async updateCase(
    workspaceId: string,
    id: string,
    input: { name?: string; input_diff?: string; expected_output?: unknown; notes?: string | null },
  ): Promise<EvalCase> {
    const row = await this.repo.updateCase(workspaceId, id, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.input_diff !== undefined ? { inputDiff: input.input_diff } : {}),
      ...(input.expected_output !== undefined
        ? { expectedOutput: this.validateExpectation(input.expected_output) }
        : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    });
    if (!row) throw new NotFoundError('Eval case not found');
    return toEvalCase(row);
  }

  async deleteCase(workspaceId: string, id: string): Promise<void> {
    const deleted = await this.repo.deleteCase(workspaceId, id);
    if (!deleted) throw new NotFoundError('Eval case not found');
  }

  /** Reject the whole submission rather than persisting a partial one (AC-17). */
  private validateExpectation(raw: unknown) {
    const parsed = EvalExpectationSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ValidationError('Expected output must be { kind, targets[] } with at least one target', {
        issues: parsed.error.issues,
      });
    }
    return parsed.data;
  }

  // ---- runs ---------------------------------------------------------------

  /**
   * Start a batch for an agent and return before the first case executes (AC-18).
   *
   * The snapshot taken here — prompt, version, provider, model, and each enabled
   * skill WITH its version — is what makes two runs comparable later. Reading
   * the agent live at compare time instead would attribute a metric movement to
   * whatever the agent happens to say today, not what it said when it ran.
   */
  async startAgentBatch(
    workspaceId: string,
    agentId: string,
    logger?: Logger,
  ): Promise<EvalBatchStart> {
    const agent = await this.container.agentsRepo.getById(workspaceId, agentId);
    if (!agent) throw new NotFoundError('Agent not found');

    const owner: EvalOwner = { workspaceId, ownerKind: 'agent', ownerId: agentId };
    const cases = await this.repo.listCases(owner);
    if (cases.length === 0) {
      throw new AppError(
        'no_eval_cases',
        'This agent has no eval cases yet — turn a reviewed finding into one first.',
        400,
      );
    }

    const links = await this.container.agentsRepo.linkedSkills(agentId);
    const skillsSnapshot = links
      .filter((l) => l.enabled && l.skill.enabled)
      .map((l) => ({ skill_id: l.skill.id, name: l.skill.name, version: l.skill.version }));

    const batch = await this.repo.startBatch({
      ...owner,
      agentVersion: agent.version,
      systemPrompt: agent.systemPrompt,
      skillsSnapshot,
      provider: agent.provider,
      model: agent.model,
      tracesTotal: cases.length,
    });

    // Fire and forget, exactly like a review run: 8 real LLM calls must not sit
    // inside the request. Failures are recorded on the batch row, never thrown
    // into a caller that has already had its response.
    void this.executor.executeBatch(batch, agent, cases, logger).catch((err) => {
      logger?.error({ batchId: batch.id, err }, 'eval batch crashed');
    });

    return { batch_id: batch.id, cases_total: cases.length };
  }

  async getBatchDetail(workspaceId: string, batchId: string): Promise<EvalBatchDetail> {
    const batch = await this.repo.getBatch(workspaceId, batchId);
    if (!batch) throw new NotFoundError('Eval run not found');
    const runs = await this.repo.runsForBatch(batchId);
    return {
      batch: toEvalBatchRecord(batch),
      runs: runs.map((r) => toEvalRunRecord(r.run, r.caseName)),
    };
  }

  async listBatches(
    workspaceId: string,
    owner?: { ownerKind: EvalOwnerKind; ownerId: string },
    limit?: number,
  ): Promise<EvalBatchRecord[]> {
    const rows = await this.repo.listBatches(workspaceId, owner, limit);
    return rows.map(toEvalBatchRecord);
  }

  // ---- dashboard + compare ------------------------------------------------

  async dashboard(workspaceId: string, ownerId: string): Promise<EvalDashboard> {
    const owner: EvalOwner = { workspaceId, ownerKind: 'agent', ownerId };
    const [casesTotal, batches] = await Promise.all([
      this.repo.countCases(owner),
      this.repo.listBatches(workspaceId, { ownerKind: 'agent', ownerId }, 30),
    ]);
    const done = batches.filter((b) => b.status === 'done');
    const current = done[0];
    const previous = done[1];

    // Oldest → newest, so the trend line reads left to right.
    const trend: EvalTrendPoint[] = [...done]
      .reverse()
      .map((b) => ({
        ran_at: b.startedAt.toISOString(),
        recall: b.recall ?? 0,
        precision: b.precision ?? 0,
        citation_accuracy: b.citationAccuracy ?? 0,
        pass_rate: b.tracesTotal > 0 ? b.tracesPassed / b.tracesTotal : 0,
        cost_usd: b.costUsd,
      }));

    const recentRuns = current ? await this.repo.runsForBatch(current.id) : [];
    const delta = (now?: number | null, before?: number | null) =>
      now === null || now === undefined || before === null || before === undefined
        ? 0
        : now - before;

    return {
      owner_kind: 'agent',
      owner_id: ownerId,
      cases_total: casesTotal,
      current: {
        recall: current?.recall ?? 0,
        precision: current?.precision ?? 0,
        citation_accuracy: current?.citationAccuracy ?? 0,
        traces_passed: current?.tracesPassed ?? 0,
        traces_total: current?.tracesTotal ?? 0,
        cost_usd: current?.costUsd ?? null,
      },
      delta: {
        recall: delta(current?.recall, previous?.recall),
        precision: delta(current?.precision, previous?.precision),
        citation_accuracy: delta(current?.citationAccuracy, previous?.citationAccuracy),
      },
      trend,
      recent_runs: recentRuns.map((r) => toEvalRunRecord(r.run, r.caseName)),
      alert: this.alertFor(current, previous),
    };
  }

  /** One-line "what changed and is it bad" banner, or null when nothing moved. */
  private alertFor(
    current?: { recall: number | null; precision: number | null; citationAccuracy: number | null },
    previous?: { recall: number | null; precision: number | null; citationAccuracy: number | null },
  ): string | null {
    if (!current || !previous) return null;
    const drops: string[] = [];
    const pts = (a: number | null, b: number | null) =>
      a === null || b === null ? 0 : Math.round((a - b) * 100);
    const p = pts(current.precision, previous.precision);
    const r = pts(current.recall, previous.recall);
    const c = pts(current.citationAccuracy, previous.citationAccuracy);
    if (p < 0) drops.push(`Precision dipped ${Math.abs(p)}pts`);
    if (r < 0) drops.push(`Recall dipped ${Math.abs(r)}pts`);
    if (c < 0) drops.push(`Citation accuracy dipped ${Math.abs(c)}pts`);
    return drops.length ? `${drops.join(' · ')} on the latest run.` : null;
  }

  /**
   * Two batches side by side.
   *
   * The mismatch flag is the load-bearing part: comparing runs over different
   * case sets produces a delta that looks like a prompt improvement and is not
   * one, and this is exactly the comparison the feature exists to make (AC-42).
   */
  async compare(workspaceId: string, aId: string, bId: string): Promise<EvalCompare> {
    const [aRow, bRow] = await Promise.all([
      this.repo.getBatch(workspaceId, aId),
      this.repo.getBatch(workspaceId, bId),
    ]);
    if (!aRow || !bRow) throw new NotFoundError('Eval run not found');

    const [aCases, bCases] = await Promise.all([
      this.repo.caseIdsForBatch(aId),
      this.repo.caseIdsForBatch(bId),
    ]);

    const a = toEvalBatchRecord(aRow);
    const b = toEvalBatchRecord(bRow);
    return {
      a,
      b,
      delta: metricDelta(a, b),
      case_set_mismatch: caseSetMismatch(aCases, bCases),
      skills_changed: skillsChanged(a, b),
    };
  }

  /** Workspace-wide: the latest batch per agent + a recent cross-agent feed. */
  async overview(workspaceId: string): Promise<{
    agents: { agent_id: string; agent_name: string; model: string | null; cases_total: number; latest: EvalBatchRecord | null }[];
    recent_runs: EvalBatchRecord[];
  }> {
    const [agents, latestBatches, recent] = await Promise.all([
      this.container.agentsRepo.list(workspaceId),
      this.repo.latestBatchPerOwner(workspaceId),
      this.repo.listBatches(workspaceId, undefined, 12),
    ]);
    const byOwner = new Map(latestBatches.map((b) => [b.ownerId, b]));

    const cards = await Promise.all(
      agents.map(async (agent) => {
        const latest = byOwner.get(agent.id);
        return {
          agent_id: agent.id,
          agent_name: agent.name,
          model: agent.model,
          cases_total: await this.repo.countCases({
            workspaceId,
            ownerKind: 'agent' as const,
            ownerId: agent.id,
          }),
          latest: latest ? toEvalBatchRecord(latest) : null,
        };
      }),
    );

    return { agents: cards, recent_runs: recent.map(toEvalBatchRecord) };
  }
}
