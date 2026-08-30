import type { EvalActualOutput, Finding } from '@devdigest/shared';
import { reviewPullRequest, formatSkillBlocks } from '@devdigest/reviewer-core';
import type { Container } from '../../platform/container.js';
import type { AgentRow } from '../../db/rows.js';
import { parseUnifiedDiff } from '../../adapters/git/diff-parser.js';
import type { EvalBatchRow, EvalCaseRow, EvalRepository } from './repository.js';
import { parseExpectation } from './helpers.js';
import { scoreCase, aggregateBatch, type CaseCounters } from './scoring.js';

/** Minimal structured logger (pino-compatible), mirroring the reviews executor. */
export type Logger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

/**
 * Background execution of one eval batch (SPEC-03).
 *
 * Mirrors `reviews/run-executor.ts`: the route responds immediately and this is
 * NOT awaited. The difference is what it feeds the engine — a frozen diff and
 * the batch's own prompt snapshot, with no repo map, project context, callers
 * digest, intent or memory (AC-21). Those vary per PR, and a run that reads them
 * would move for reasons that have nothing to do with the agent's definition,
 * which defeats the whole point of comparing two runs.
 */
export class EvalRunExecutor {
  constructor(
    private container: Container,
    private repo: EvalRepository,
  ) {}

  async executeBatch(
    batch: EvalBatchRow,
    agent: AgentRow,
    cases: EvalCaseRow[],
    logger?: Logger,
  ): Promise<void> {
    const startedAt = Date.now();
    const counters: CaseCounters[] = [];
    const passes: boolean[] = [];
    let tokensIn = 0;
    let tokensOut = 0;
    let costUsd: number | null = 0;
    let fatal: string | null = null;

    // Resolved once: the snapshot is what the whole batch runs against, so a
    // mid-batch agent edit cannot change the answer half way through (AC-39).
    let llm;
    let skillBlocks: string[] = [];
    try {
      llm = await this.container.llm(agent.provider);
      skillBlocks = await this.buildSkillBlocks(agent);
    } catch (err) {
      // No provider means every case would fail with the same reason; record it
      // once on the batch rather than N times, and never leave it `running`.
      fatal = `Could not start eval run: ${(err as Error).message}`;
      logger?.error({ batchId: batch.id, err }, fatal);
      await this.repo.finishBatch(batch.id, {
        status: 'failed',
        recall: null,
        precision: null,
        citationAccuracy: null,
        tracesPassed: 0,
        tracesTotal: cases.length,
        durationMs: Date.now() - startedAt,
        tokensIn: null,
        tokensOut: null,
        costUsd: null,
        error: fatal,
      });
      this.container.runBus.complete(batch.id);
      return;
    }

    for (const evalCase of cases) {
      const caseStart = Date.now();
      try {
        const expectation = parseExpectation(evalCase.expectedOutput, evalCase.name);
        const diff = parseUnifiedDiff(evalCase.inputDiff ?? '');

        const outcome = await reviewPullRequest({
          systemPrompt: batch.systemPrompt,
          model: batch.model ?? agent.model,
          diff,
          llm,
          // Forced, not `agent.strategy`: map-reduce would split a case's diff
          // into a different number of LLM calls depending on its size, so two
          // runs of the same set would not be cost- or output-comparable (AC-22).
          strategy: 'single-pass',
          ...(skillBlocks.length ? { skills: skillBlocks } : {}),
          task: `Eval case '${evalCase.name}'`,
        });

        // `outcome.review.findings` are already GROUNDED — the engine runs the
        // citation gate before returning, so this is the same set a real review
        // would have persisted, and `dropped` is what the gate rejected.
        const kept = outcome.review.findings;
        const score = scoreCase(expectation, kept, outcome.dropped.length);

        const actual: EvalActualOutput = {
          findings: kept,
          // Persisted WITH reasons: citation_accuracy is otherwise a number you
          // cannot act on — you see it fell, not which citation was invented.
          dropped: outcome.dropped.map((d) => ({ finding: d.finding as Finding, reason: d.reason })),
          grounding: outcome.grounding,
        };

        tokensIn += outcome.tokensIn;
        tokensOut += outcome.tokensOut;
        costUsd = costUsd === null || outcome.costUsd === null ? null : costUsd + outcome.costUsd;

        await this.repo.insertRun({
          batchId: batch.id,
          caseId: evalCase.id,
          actualOutput: actual,
          pass: score.pass,
          recall: score.recall,
          precision: score.precision,
          citationAccuracy: score.citationAccuracy,
          tp: score.tp,
          fp: score.fp,
          fn: score.fn,
          kept: score.kept,
          dropped: score.dropped,
          durationMs: Date.now() - caseStart,
          tokensIn: outcome.tokensIn,
          tokensOut: outcome.tokensOut,
          costUsd: outcome.costUsd,
          error: null,
        });

        counters.push(score);
        passes.push(score.pass);
        this.container.runBus.publish(
          batch.id,
          'info',
          `${evalCase.name}: ${score.pass ? 'pass' : 'fail'} (${score.tp} found, ${score.fp} noise)`,
        );
      } catch (err) {
        // One bad case must not abort the set (AC-23): the remaining cases still
        // carry information, and a half-run batch would be unreadable.
        const message = (err as Error).message;
        logger?.warn({ batchId: batch.id, caseId: evalCase.id, err }, 'eval case failed');
        await this.repo
          .insertRun({
            batchId: batch.id,
            caseId: evalCase.id,
            actualOutput: null,
            pass: false,
            recall: null,
            precision: null,
            citationAccuracy: null,
            tp: 0,
            fp: 0,
            fn: 0,
            kept: 0,
            dropped: 0,
            durationMs: Date.now() - caseStart,
            tokensIn: null,
            tokensOut: null,
            costUsd: null,
            error: message,
          })
          .catch(() => undefined);
        // A failed case contributes no counters — folding zeros in would drag
        // every metric down and read as a quality regression rather than an
        // execution failure. It still counts as a non-passing trace.
        passes.push(false);
        this.container.runBus.publish(batch.id, 'error', `${evalCase.name}: failed — ${message}`);
      }
    }

    const metrics = aggregateBatch(counters, passes);
    await this.repo.finishBatch(batch.id, {
      status: 'done',
      recall: metrics.recall,
      precision: metrics.precision,
      citationAccuracy: metrics.citationAccuracy,
      tracesPassed: metrics.tracesPassed,
      tracesTotal: metrics.tracesTotal,
      durationMs: Date.now() - startedAt,
      tokensIn,
      tokensOut,
      costUsd,
      error: fatal,
    });
    logger?.info(
      { batchId: batch.id, ...metrics },
      `eval batch complete: ${metrics.tracesPassed}/${metrics.tracesTotal} passed`,
    );
    this.container.runBus.complete(batch.id);
  }

  /**
   * The agent's enabled skill bodies, delimiter-wrapped exactly as a real review
   * wraps them. Reused rather than re-implemented so an eval measures the prompt
   * the agent actually runs with — including the untrusted-skill boundary.
   */
  private async buildSkillBlocks(agent: AgentRow): Promise<string[]> {
    const links = await this.container.agentsRepo.linkedSkills(agent.id);
    const active = links.filter((l) => l.enabled && l.skill.enabled);
    if (active.length === 0) return [];
    return formatSkillBlocks(
      active.map((l) => ({
        name: l.skill.name,
        body: l.skill.body,
        trusted: l.skill.source === 'manual',
      })),
    );
  }
}
