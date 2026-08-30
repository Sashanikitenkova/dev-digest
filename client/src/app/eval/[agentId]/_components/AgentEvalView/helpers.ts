import type { EvalBatchRecord, EvalSkillSnapshot } from "@devdigest/shared";

/** Whole-percent string, or null when the metric has no evidence. */
export function pct(value: number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return `${Math.round(value * 100)}%`;
}

/** A signed delta in percentage points, e.g. "+4pts" / "-2pts". */
export function deltaPts(value: number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const pts = Math.round(value * 100);
  if (pts === 0) return "0pts";
  return `${pts > 0 ? "+" : ""}${pts}pts`;
}

export function deltaColor(value: number | null | undefined): string {
  if (value === null || value === undefined || Math.round(value * 100) === 0) {
    return "var(--text-muted)";
  }
  return value > 0 ? "var(--ok)" : "var(--crit)";
}

export function runTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Chart series for the trend, oldest → newest.
 *
 * The API returns runs newest-first (the table's order); a line drawn in that
 * order shows every trend reversed, which is worse than showing none.
 */
export function trendSeries(batches: EvalBatchRecord[]): {
  recall: number[];
  precision: number[];
  citation: number[];
} {
  const done = [...batches].filter((b) => b.status === "done").reverse();
  return {
    recall: done.map((b) => b.recall ?? 0),
    precision: done.map((b) => b.precision ?? 0),
    citation: done.map((b) => b.citation_accuracy ?? 0),
  };
}

/** "skill-name v3, other v1" — or null when a run linked no skills. */
export function skillsLabel(snapshot: EvalSkillSnapshot[]): string | null {
  if (!snapshot.length) return null;
  return snapshot.map((s) => `${s.name ?? s.skill_id.slice(0, 8)} v${s.version}`).join(", ");
}

/**
 * Order two selected runs oldest-first.
 *
 * A comparison reads "old → new"; letting click order decide would flip the
 * sign of every delta depending on which checkbox the user happened to tick
 * first, so the pair is sorted by time rather than by selection.
 */
export function orderPair(a: EvalBatchRecord, b: EvalBatchRecord): [EvalBatchRecord, EvalBatchRecord] {
  return new Date(a.started_at) <= new Date(b.started_at) ? [a, b] : [b, a];
}
