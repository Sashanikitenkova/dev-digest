import type { Finding, EvalExpectation, EvalExpectedTarget } from '@devdigest/shared';

/**
 * Eval scoring — the deterministic core of the eval pipeline (SPEC-03).
 *
 * PURE BY CONTRACT. This module imports no `Container`, no adapter, no port, no
 * LLM client and no database. That is the point of the lesson: the lab's harness
 * needed an LLM judge because "explained the cause" is not a substring, but here
 * an expectation is a `file:line` and a match is arithmetic. Scoring makes zero
 * model calls (SPEC-03 AC-26), so two runs of the same inputs always produce the
 * same numbers and a metric movement is attributable to the agent definition.
 *
 * Keep it that way: if this file ever needs an import from `../../platform` or
 * `../../adapters`, the logic belongs in the service or the executor instead.
 */

/**
 * Raw counters for one case. The RATES are derived from these, never the other
 * way round — a batch aggregates by summing counters across cases, so these are
 * what gets persisted and what makes a batch row auditable afterwards
 * (SPEC-03 AC-36).
 */
export interface CaseCounters {
  /** Expected targets that a grounded finding matched. */
  tp: number;
  /** Findings that matched nothing expected — the noise term. */
  fp: number;
  /** Expected targets no finding matched. */
  fn: number;
  /** Findings that survived the grounding gate. */
  kept: number;
  /** Findings the grounding gate rejected as ungrounded citations. */
  dropped: number;
}

export interface CaseScore extends CaseCounters {
  pass: boolean;
  /** Null when this case contributes no denominator (see `ratio`). */
  recall: number | null;
  precision: number | null;
  citationAccuracy: number | null;
}

export interface BatchMetrics {
  recall: number;
  precision: number;
  citationAccuracy: number;
  tracesPassed: number;
  tracesTotal: number;
}

/**
 * Does this finding satisfy this target?
 *
 * Same file AND overlapping line ranges — nothing else. Severity, category and
 * title are deliberately NOT read (SPEC-03 AC-28): they are model prose, they
 * drift with every prompt edit, and matching on them would turn a wording change
 * into a fake regression. The range comparison mirrors `rangeIntersects` in
 * `reviewer-core/src/grounding.ts` so a finding that satisfies the grounding
 * gate and a finding that satisfies a target are judged on the same geometry.
 */
export function matchesTarget(
  finding: Pick<Finding, 'file' | 'start_line' | 'end_line'>,
  target: EvalExpectedTarget,
): boolean {
  if (finding.file !== target.file) return false;
  const fLo = Math.min(finding.start_line, finding.end_line);
  const fHi = Math.max(finding.start_line, finding.end_line);
  const tLo = Math.min(target.start_line, target.end_line);
  const tHi = Math.max(target.start_line, target.end_line);
  return fLo <= tHi && tLo <= fHi;
}

/**
 * A rate, or null when there is no evidence for one.
 *
 * A zero denominator is NOT a zero score and NOT a perfect score — it is an
 * absence of evidence, and conflating the three is how an eval dashboard starts
 * lying. Per-case rates therefore carry null; only the batch collapses null to 1
 * (SPEC-03 AC-35), and the surface displaying it has to label that case.
 */
function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/**
 * Score one case against the findings a run produced for it.
 *
 * `findings` are the GROUNDED findings (post-gate); `droppedCount` is how many
 * the gate rejected. Citation accuracy is measured over what the model proposed,
 * which is why the dropped count has to be passed in rather than inferred.
 */
export function scoreCase(
  expectation: EvalExpectation,
  findings: Pick<Finding, 'file' | 'start_line' | 'end_line'>[],
  droppedCount: number,
): CaseScore {
  const kept = findings.length;
  const counters =
    expectation.kind === 'must_find'
      ? scoreMustFind(expectation.targets, findings)
      : scoreMustNotFlag(expectation.targets, findings);

  const pass =
    expectation.kind === 'must_find'
      ? counters.fn === 0 && counters.tp === expectation.targets.length
      : counters.fp === 0;

  return {
    ...counters,
    kept,
    dropped: droppedCount,
    pass,
    recall: ratio(counters.tp, counters.tp + counters.fn),
    precision: ratio(counters.tp, counters.tp + counters.fp),
    citationAccuracy: ratio(kept, kept + droppedCount),
  };
}

/**
 * An accepted finding: the agent must still report it.
 *
 * A target is matched at most once and a finding satisfies at most one target,
 * so two findings piled on the same expected line count as one true positive and
 * one false positive rather than inflating recall.
 */
function scoreMustFind(
  targets: EvalExpectedTarget[],
  findings: Pick<Finding, 'file' | 'start_line' | 'end_line'>[],
): Omit<CaseCounters, 'kept' | 'dropped'> {
  const claimed = new Set<number>();
  let fp = 0;

  for (const finding of findings) {
    const hit = targets.findIndex((target, i) => !claimed.has(i) && matchesTarget(finding, target));
    if (hit === -1) fp += 1;
    else claimed.add(hit);
  }

  return { tp: claimed.size, fp, fn: targets.length - claimed.size };
}

/**
 * A dismissed finding: the agent must NOT report it here again.
 *
 * There is nothing to recall, so this case contributes only to the precision
 * denominator — which is exactly where a dismissed decision earns its keep, and
 * why a prompt that gets noisier moves precision down while recall holds
 * (SPEC-03 AC-30). Findings elsewhere in the fragment are ignored: the author
 * judged this one spot, not the whole file.
 */
function scoreMustNotFlag(
  targets: EvalExpectedTarget[],
  findings: Pick<Finding, 'file' | 'start_line' | 'end_line'>[],
): Omit<CaseCounters, 'kept' | 'dropped'> {
  const fp = findings.filter((f) => targets.some((t) => matchesTarget(f, t))).length;
  return { tp: 0, fp, fn: 0 };
}

/**
 * Collapse per-case counters into the three headline metrics.
 *
 * SUM the counters; never average the per-case rates. A mean of rates weights a
 * one-target case identically to a five-target case and silently rewards adding
 * trivial cases to the set — so the aggregate would move when the set changed
 * rather than when the agent did (SPEC-03 AC-32).
 *
 * A zero denominator yields 1: the contract requires a number in [0,1], and "no
 * expectations of this kind were tested" is not a failure. The surface must say
 * "no evidence" rather than render it as a perfect score.
 */
export function aggregateBatch(scores: CaseCounters[], passes: boolean[]): BatchMetrics {
  const sum = (pick: (c: CaseCounters) => number) => scores.reduce((n, c) => n + pick(c), 0);
  const tp = sum((c) => c.tp);
  const fp = sum((c) => c.fp);
  const fn = sum((c) => c.fn);
  const kept = sum((c) => c.kept);
  const dropped = sum((c) => c.dropped);

  return {
    recall: ratio(tp, tp + fn) ?? 1,
    precision: ratio(tp, tp + fp) ?? 1,
    citationAccuracy: ratio(kept, kept + dropped) ?? 1,
    tracesPassed: passes.filter(Boolean).length,
    tracesTotal: passes.length,
  };
}
