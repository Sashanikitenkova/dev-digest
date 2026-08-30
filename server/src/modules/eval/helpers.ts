import type {
  EvalBatchRecord,
  EvalCase,
  EvalExpectation,
  EvalRunRecord,
  EvalMetricDelta,
} from '@devdigest/shared';
import { EvalExpectation as EvalExpectationSchema } from '@devdigest/shared';
import type { FindingRow } from '../../db/rows.js';
import { ValidationError } from '../../platform/errors.js';
import type { EvalBatchRow, EvalCaseRow, EvalRunRow } from './repository.js';

/**
 * Pure row→DTO mappers and derivations for the eval module. No I/O, no LLM.
 */

/**
 * Derive an expectation from the decision the author already made.
 *
 * This is the whole premise of the feature: accept/dismiss clicks from L01–L05
 * are a labelled dataset, so nobody has to invent test scenarios. An accepted
 * finding becomes "you must still catch this"; a dismissed one becomes "you must
 * not say this here again" (SPEC-03 AC-2, AC-3).
 *
 * A finding with neither decision is not a label and must not become a case
 * (AC-4) — guessing a default here would quietly seed the gold set with
 * unreviewed model output.
 */
export function expectationFromFinding(finding: FindingRow): EvalExpectation {
  const kind = finding.acceptedAt ? 'must_find' : finding.dismissedAt ? 'must_not_flag' : null;
  if (!kind) {
    throw new ValidationError(
      'Accept or dismiss this finding first — an eval case records a decision you already made.',
    );
  }
  return {
    kind,
    targets: [
      {
        file: finding.file,
        start_line: finding.startLine,
        end_line: finding.endLine,
        // Display-only provenance; scoring never reads these (AC-28).
        severity: finding.severity,
        category: finding.category,
        title: finding.title,
      },
    ],
  };
}

/** Slug a finding's title into a stable case name, e.g. "stripe-key-leak". */
export function caseNameFromFinding(finding: FindingRow): string {
  const slug = finding.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .slice(0, 5)
    .join('-');
  return slug || `finding-${finding.file.split('/').pop() ?? 'case'}:${finding.startLine}`;
}

/**
 * Parse `eval_cases.expected_output` (jsonb, so `unknown` at the type level).
 *
 * Rejects rather than repairing: a case whose expectation cannot be read has no
 * defensible score, and scoring it as "found nothing" would read as a real
 * regression in the dashboard.
 */
export function parseExpectation(raw: unknown, caseName: string): EvalExpectation {
  const parsed = EvalExpectationSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(
      `Eval case '${caseName}' has an unreadable expectation: ${parsed.error.issues
        .map((i) => `${i.path.join('.') || 'root'} ${i.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

export function toEvalCase(row: EvalCaseRow): EvalCase {
  return {
    id: row.id,
    owner_kind: row.ownerKind,
    owner_id: row.ownerId,
    name: row.name,
    input_diff: row.inputDiff ?? '',
    input_files: row.inputFiles,
    input_meta: row.inputMeta,
    expected_output: row.expectedOutput,
    notes: row.notes,
    source_finding_id: row.sourceFindingId,
    created_at: row.createdAt.toISOString(),
  };
}

export function toEvalRunRecord(row: EvalRunRow, caseName?: string | null): EvalRunRecord {
  return {
    id: row.id,
    case_id: row.caseId,
    case_name: caseName ?? null,
    batch_id: row.batchId,
    ran_at: row.ranAt.toISOString(),
    actual_output: row.actualOutput,
    pass: row.pass,
    recall: row.recall,
    precision: row.precision,
    citation_accuracy: row.citationAccuracy,
    tp: row.tp,
    fp: row.fp,
    fn: row.fn,
    kept: row.kept,
    dropped: row.dropped,
    duration_ms: row.durationMs,
    tokens_in: row.tokensIn,
    tokens_out: row.tokensOut,
    cost_usd: row.costUsd,
    error: row.error,
  };
}

export function toEvalBatchRecord(row: EvalBatchRow): EvalBatchRecord {
  return {
    id: row.id,
    owner_kind: row.ownerKind,
    owner_id: row.ownerId,
    status: row.status,
    started_at: row.startedAt.toISOString(),
    finished_at: row.finishedAt ? row.finishedAt.toISOString() : null,
    agent_version: row.agentVersion,
    system_prompt: row.systemPrompt,
    skills_snapshot: row.skillsSnapshot ?? [],
    provider: row.provider,
    model: row.model,
    recall: row.recall,
    precision: row.precision,
    citation_accuracy: row.citationAccuracy,
    traces_passed: row.tracesPassed,
    traces_total: row.tracesTotal,
    duration_ms: row.durationMs,
    tokens_in: row.tokensIn,
    tokens_out: row.tokensOut,
    cost_usd: row.costUsd,
    error: row.error,
  };
}

/** `b - a` per metric; null when either side has no value. */
export function metricDelta(a: EvalBatchRecord, b: EvalBatchRecord): EvalMetricDelta {
  const diff = (x: number | null, y: number | null) => (x === null || y === null ? null : y - x);
  return {
    recall: diff(a.recall, b.recall),
    precision: diff(a.precision, b.precision),
    citation_accuracy: diff(a.citation_accuracy, b.citation_accuracy),
    cost_usd: diff(a.cost_usd, b.cost_usd),
  };
}

/**
 * Did two batches snapshot the same enabled skills at the same versions?
 *
 * Compares VERSIONS, not just ids: editing a linked skill's body bumps
 * `skills.version` without changing the link, and that is precisely the silent
 * change that makes two runs incomparable (SPEC-03 AC-43).
 */
export function skillsChanged(a: EvalBatchRecord, b: EvalBatchRecord): boolean {
  const key = (r: EvalBatchRecord) =>
    r.skills_snapshot
      .map((s) => `${s.skill_id}@${s.version}`)
      .sort()
      .join(',');
  return key(a) !== key(b);
}

/** True when the two batches did not execute the same set of cases (AC-42). */
export function caseSetMismatch(aCaseIds: string[], bCaseIds: string[]): boolean {
  const a = [...new Set(aCaseIds)].sort().join(',');
  const b = [...new Set(bCaseIds)].sort().join(',');
  return a !== b;
}
