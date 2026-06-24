/**
 * Shared USD-cost formatting for review runs. One magnitude-adaptive rule
 * instead of a fixed precision, so small per-run costs (sub-cent) render
 * with more precision than larger rollups (e.g. a PR's latest review round),
 * from a single function every surface shares.
 */

/**
 * Format a run/PR's accumulated LLM cost. `null` means "no data" (e.g. an
 * unpriced model, or a PR with no agent runs yet) and renders as "–" — never
 * "$0.00", which is reserved for a confirmed zero-cost run.
 */
export function formatCost(usd: number | null): string {
  if (usd == null) return "–";
  if (usd === 0) return "$0.00";
  return usd >= 0.01 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(4)}`;
}
