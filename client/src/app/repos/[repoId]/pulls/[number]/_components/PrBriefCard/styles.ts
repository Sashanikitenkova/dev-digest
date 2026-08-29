import type { CSSProperties } from "react";

/** The summary text inside a row: readable prose even when the row's own
    element is monospace (a `MonoLink` sets `.mono` on the anchor itself). */
const summaryFont = 'var(--font-sans, "Inter", -apple-system, sans-serif)';

/** The shared half of the two empty-section sentences. Hoisted because a member
    of `s` cannot spread another member while `s` is still being initialised, and
    left UNANNOTATED on purpose: typing it as `CSSProperties` widens every member
    that spreads it to csstype's own type, which `tsc` then cannot name portably
    (TS2742). `satisfies` checks it without widening. */
const emptyText = { fontSize: 13, lineHeight: 1.5 } satisfies CSSProperties;

export const s = {
  card: {
    border: "1px solid var(--border)",
    borderRadius: 8,
    background: "var(--bg-elevated)",
    padding: 18,
    display: "flex",
    flexDirection: "column",
    gap: 14,
  } satisfies CSSProperties,

  headRight: {
    display: "flex",
    alignItems: "center",
    gap: 10,
  } satisfies CSSProperties,

  /* Colour is an accent on top of the level's text label, never the only
     carrier of the level — `Low risk` / `Medium risk` / `High risk` is always
     spelled out inside the pill. */
  pill: (color: string): CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontSize: 11.5,
    fontWeight: 600,
    letterSpacing: 0.3,
    padding: "3px 9px",
    borderRadius: 999,
    border: `1px solid color-mix(in srgb, ${color} 40%, transparent)`,
    background: `color-mix(in srgb, ${color} 12%, transparent)`,
    color: "var(--text-primary)",
  }),

  staleBanner: {
    display: "flex",
    alignItems: "flex-start",
    gap: 8,
    padding: "8px 10px",
    borderRadius: 6,
    background: "color-mix(in srgb, var(--warn) 12%, transparent)",
    border: "1px solid color-mix(in srgb, var(--warn) 35%, transparent)",
    fontSize: 12,
    lineHeight: 1.45,
    color: "var(--text-secondary)",
  } satisfies CSSProperties,

  errorBanner: {
    display: "flex",
    alignItems: "flex-start",
    gap: 8,
    padding: "8px 10px",
    borderRadius: 6,
    background: "var(--crit-bg)",
    border: "1px solid color-mix(in srgb, var(--crit) 35%, transparent)",
    fontSize: 12,
    lineHeight: 1.45,
    color: "var(--text-secondary)",
  } satisfies CSSProperties,

  block: { display: "flex", flexDirection: "column", gap: 5 } satisfies CSSProperties,

  blockLabel: {
    fontSize: 11,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    color: "var(--text-muted)",
  } satisfies CSSProperties,

  prose: {
    margin: 0,
    fontSize: 14,
    lineHeight: 1.55,
    color: "var(--text-primary)",
  } satisfies CSSProperties,

  section: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    borderTop: "1px solid var(--border)",
    paddingTop: 12,
  } satisfies CSSProperties,

  sectionHead: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 11,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    color: "var(--text-muted)",
  } satisfies CSSProperties,

  countBadge: {
    fontSize: 11,
    fontWeight: 600,
    padding: "1px 7px",
    borderRadius: 999,
    border: "1px solid var(--border)",
    background: "var(--bg-base)",
    color: "var(--text-secondary)",
  } satisfies CSSProperties,

  list: {
    margin: 0,
    padding: 0,
    listStyle: "none",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  } satisfies CSSProperties,

  empty: { ...emptyText, color: "var(--text-muted)" } satisfies CSSProperties,

  /** The empty Risks sentence when every risk the model raised was dropped:
      a discarded answer is a signal, not an absence, so it is not muted. */
  emptyWarn: { ...emptyText, color: "var(--warn)" } satisfies CSSProperties,

  riskRow: {
    display: "flex",
    alignItems: "baseline",
    flexWrap: "wrap",
    gap: 8,
    fontSize: 13,
    lineHeight: 1.5,
    color: "var(--text-secondary)",
  } satisfies CSSProperties,

  severityTag: (color: string): CSSProperties => ({
    flex: "0 0 auto",
    fontSize: 11,
    fontWeight: 600,
    padding: "2px 8px",
    borderRadius: 4,
    border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`,
    background: `color-mix(in srgb, ${color} 10%, transparent)`,
    color: "var(--text-primary)",
  }),

  riskSummary: { color: "var(--text-primary)" } satisfies CSSProperties,

  riskRef: { fontSize: 12, color: "var(--text-muted)" } satisfies CSSProperties,

  focusRow: { display: "flex", fontSize: 13, lineHeight: 1.5 } satisfies CSSProperties,

  /* An in-diff row is a real button, reset to look like the text it wraps. */
  rowButton: {
    display: "block",
    textAlign: "left",
    background: "none",
    border: "none",
    padding: 0,
    font: "inherit",
    fontSize: 13,
    cursor: "pointer",
    color: "var(--text-secondary)",
  } satisfies CSSProperties,

  /* The non-navigating case: plain text, no control semantics at all. */
  rowStatic: { color: "var(--text-secondary)" } satisfies CSSProperties,

  rowRef: { color: "var(--text-primary)" } satisfies CSSProperties,

  rowSummary: { fontFamily: summaryFont, color: "var(--text-secondary)" } satisfies CSSProperties,
} as const;
