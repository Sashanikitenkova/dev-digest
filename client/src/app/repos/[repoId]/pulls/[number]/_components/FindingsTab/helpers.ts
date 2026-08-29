import type { ReviewRecord } from "@devdigest/shared";

export type SeverityCounts = { CRITICAL: number; WARNING: number; SUGGESTION: number };

/** Aggregate finding counts by severity across every run's findings. */
export function countBySeverity(runs: ReviewRecord[]): SeverityCounts {
  const all = runs.flatMap((r) => r.findings);
  return {
    CRITICAL: all.filter((f) => f.severity === "CRITICAL").length,
    WARNING: all.filter((f) => f.severity === "WARNING").length,
    SUGGESTION: all.filter((f) => f.severity === "SUGGESTION").length,
  };
}
