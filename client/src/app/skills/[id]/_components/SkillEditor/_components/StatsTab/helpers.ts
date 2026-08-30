import type { DonutSegment } from "@devdigest/ui";
import { CATEGORY_COLORS, DEFAULT_CATEGORY_COLOR } from "./constants";

/**
 * Format a 0..1 rate as a whole percentage, or `null` when there is no rate.
 *
 * Null is passed through rather than coerced to 0: the server sends null to
 * mean "no evidence in the window", and printing 0% there would assert the
 * skill was offered and never pulled, which is a claim the data doesn't make.
 */
export function formatRate(rate: number | null): string | null {
  if (rate === null) return null;
  return `${Math.round(rate * 100)}`;
}

/** Map finding categories onto donut segments, with a colour fallback. */
export function toSegments(
  rows: { category: string; count: number }[],
): DonutSegment[] {
  return rows.map((r) => ({
    label: r.category,
    value: r.count,
    color: CATEGORY_COLORS[r.category] ?? DEFAULT_CATEGORY_COLOR,
  }));
}
