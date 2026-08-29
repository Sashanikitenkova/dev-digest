/** Constants for the Skill editor's Stats tab. */

/**
 * Colours for the findings-by-category donut, keyed by the `findings.category`
 * values the reviewer emits. Anything unrecognised falls back to `DEFAULT` —
 * a new category must never crash the chart or render an invisible slice.
 */
export const CATEGORY_COLORS: Record<string, string> = {
  security: "var(--crit)",
  bug: "var(--warn, #d99a2b)",
  perf: "var(--accent-alt, #8b6ff0)",
  style: "var(--accent)",
};

export const DEFAULT_CATEGORY_COLOR = "var(--text-muted)";

/** Donut geometry — matches the tile row's height so the two cards align. */
export const DONUT_SIZE = 130;
