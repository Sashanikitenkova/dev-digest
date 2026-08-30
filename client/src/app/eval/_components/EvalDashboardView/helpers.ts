import type { EvalBatchRecord } from "@devdigest/shared";

/**
 * A metric as a whole-percent string, or null when there is no evidence.
 *
 * Null is not zero and not 100: a batch that never ran, or a metric with no
 * denominator, has measured nothing. Rendering either as a number would let the
 * dashboard assert a score it does not have (SPEC-03 AC-35).
 */
export function pct(value: number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return `${Math.round(value * 100)}%`;
}

/** Short local timestamp for a run row, e.g. "2026-08-30 09:14". */
export function runTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Recall points for an agent's sparkline, oldest → newest.
 *
 * `listBatches` returns newest first (the table's order), so this reverses;
 * a sparkline drawn newest-first would show every trend backwards.
 */
export function recallTrend(batches: EvalBatchRecord[]): number[] {
  return [...batches]
    .reverse()
    .map((b) => b.recall)
    .filter((r): r is number => r !== null);
}
