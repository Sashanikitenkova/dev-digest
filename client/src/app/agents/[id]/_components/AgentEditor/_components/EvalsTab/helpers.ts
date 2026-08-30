import type { EvalCase, EvalExpectation, EvalRunRecord } from "@devdigest/shared";

/**
 * Format a metric for display.
 *
 * `null` means "no evidence", which is NOT 0% and NOT 100%: a set with no
 * must_find targets has no recall denominator, and rendering that as a number
 * would let the dashboard claim a score it never measured (SPEC-03 AC-35).
 */
export function formatMetric(value: number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return String(Math.round(value * 100));
}

/** The expectation stored on a case, or null when it is unreadable. */
export function expectationOf(evalCase: EvalCase): EvalExpectation | null {
  const raw = evalCase.expected_output as EvalExpectation | null;
  if (!raw || typeof raw !== "object" || !("kind" in raw)) return null;
  return raw;
}

/** "src/config.ts:11" or "src/api/users.ts:44-46" for the case subtitle. */
export function targetLabel(evalCase: EvalCase): string | null {
  const target = expectationOf(evalCase)?.targets?.[0];
  if (!target) return null;
  const lines =
    target.end_line > target.start_line
      ? `${target.start_line}-${target.end_line}`
      : String(target.start_line);
  return `${target.file}:${lines}`;
}

export type CaseStatus = "passed" | "failed" | "never";

export function caseStatus(latest: EvalRunRecord | undefined): CaseStatus {
  if (!latest) return "never";
  return latest.pass ? "passed" : "failed";
}

/** Count of cases whose latest run passed, over the cases that have ever run. */
export function passSummary(
  cases: EvalCase[],
  latest: Record<string, EvalRunRecord>,
): { passed: number; ran: number } {
  const ran = cases.filter((c) => latest[c.id]);
  return { passed: ran.filter((c) => latest[c.id]!.pass).length, ran: ran.length };
}
