import type { FindingRecord } from "@devdigest/shared";
import { LOW_CONFIDENCE_THRESHOLD, SEVERITY_ORDER } from "./constants";

/** Optionally drop low-confidence and out-of-scope findings, then sort by severity. */
export function visibleFindings(
  findings: FindingRecord[],
  hideLow: boolean,
  hideOutOfScope = false,
): FindingRecord[] {
  let shown = findings;
  if (hideLow) shown = shown.filter((f) => f.confidence >= LOW_CONFIDENCE_THRESHOLD);
  // Safe to collapse by default only because the scope filter can never tag a
  // CRITICAL, security or correctness finding — see reviewer-core/src/scope.ts.
  if (hideOutOfScope) shown = shown.filter((f) => !f.out_of_scope);
  return [...shown].sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9),
  );
}

/** How many of these findings the scope filter demoted. Drives the toggle label. */
export function countOutOfScope(findings: FindingRecord[]): number {
  return findings.filter((f) => f.out_of_scope).length;
}
