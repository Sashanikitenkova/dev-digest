import type { ReviewRecord, RunSummary } from "@devdigest/shared";

/**
 * The review the brief header speaks for. `usePrReviews` returns newest-first,
 * so the first row with a verdict wins — a `kind: "summary"` row or a run that
 * failed before producing a verdict must not blank out the header.
 */
export function latestVerdictReview(reviews: ReviewRecord[]): ReviewRecord | null {
  return reviews.find((r) => r.verdict != null) ?? null;
}

/**
 * Blockers = undismissed CRITICAL findings. Same rule as ReviewRunAccordion —
 * dismissing a blocker has to clear it here too, or the two disagree on the
 * same PR.
 */
export function countBlockers(review: ReviewRecord): number {
  return review.findings.filter((f) => f.severity === "CRITICAL" && !f.dismissed_at).length;
}

/**
 * Cost/token accounting lives on the RUN, not the review (`RunSummary`), so the
 * footnote has to be joined back by `run_id`. A review whose run row was deleted
 * from history keeps its verdict and simply shows no footnote.
 */
export function runForReview(
  review: ReviewRecord,
  runs: RunSummary[] | undefined,
): RunSummary | null {
  if (!review.run_id) return null;
  return runs?.find((r) => r.run_id === review.run_id) ?? null;
}

/**
 * 8234 → "8.2K". Compact enough to sit next to the cost without wrapping.
 *
 * Cost formatting is deliberately NOT defined here — `lib/cost.ts` owns the one
 * magnitude-adaptive rule every cost surface shares, and a second local rule is
 * exactly how the drawer and the PR list drifted apart before.
 */
export function formatTokens(n: number | null | undefined): string | null {
  if (n == null) return null;
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
