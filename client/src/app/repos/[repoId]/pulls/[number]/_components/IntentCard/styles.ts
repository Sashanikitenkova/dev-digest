import type { CSSProperties } from "react";

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

  head: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  } satisfies CSSProperties,

  intent: {
    margin: 0,
    fontSize: 15,
    lineHeight: 1.5,
    color: "var(--text-primary)",
    fontStyle: "italic",
  } satisfies CSSProperties,

  confidenceRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    fontSize: 12,
    color: "var(--text-muted)",
  } satisfies CSSProperties,

  bar: { flex: "0 0 96px" } satisfies CSSProperties,

  staleBanner: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 10px",
    borderRadius: 6,
    background: "color-mix(in srgb, var(--warn) 12%, transparent)",
    border: "1px solid color-mix(in srgb, var(--warn) 35%, transparent)",
    fontSize: 12,
    color: "var(--text-secondary)",
  } satisfies CSSProperties,

  scopeGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 18,
  } satisfies CSSProperties,

  scopeCol: { display: "flex", flexDirection: "column", gap: 6 } satisfies CSSProperties,

  scopeHead: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 11,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    color: "var(--text-muted)",
  } satisfies CSSProperties,

  scopeList: {
    margin: 0,
    padding: 0,
    listStyle: "none",
    display: "flex",
    flexDirection: "column",
    gap: 4,
  } satisfies CSSProperties,

  scopeItem: {
    fontSize: 13,
    color: "var(--text-secondary)",
    lineHeight: 1.45,
  } satisfies CSSProperties,

  scopeEmpty: { fontSize: 13, color: "var(--text-muted)" } satisfies CSSProperties,

  risks: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    borderTop: "1px solid var(--border)",
    paddingTop: 12,
  } satisfies CSSProperties,

  riskChips: { display: "flex", flexWrap: "wrap", gap: 8 } satisfies CSSProperties,

  riskChip: (color: string): CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontSize: 12,
    padding: "5px 10px",
    borderRadius: 6,
    border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`,
    background: `color-mix(in srgb, ${color} 10%, transparent)`,
    color: "var(--text-secondary)",
  }),

  riskIcon: (color: string): CSSProperties => ({ color, display: "inline-flex" }),

  sources: {
    display: "flex",
    flexWrap: "wrap",
    gap: 6,
    alignItems: "center",
    borderTop: "1px solid var(--border)",
    paddingTop: 12,
  } satisfies CSSProperties,

  sourcesLabel: {
    fontSize: 11,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    color: "var(--text-muted)",
    marginRight: 2,
  } satisfies CSSProperties,

  chip: {
    fontSize: 11,
    padding: "2px 8px",
    borderRadius: 999,
    border: "1px solid var(--border)",
    background: "var(--bg-base)",
    color: "var(--text-secondary)",
    whiteSpace: "nowrap",
    maxWidth: 260,
    overflow: "hidden",
    textOverflow: "ellipsis",
  } satisfies CSSProperties,

  chipMissing: {
    color: "var(--text-muted)",
    borderStyle: "dashed",
    opacity: 0.85,
  } satisfies CSSProperties,

  footnote: {
    fontSize: 11,
    color: "var(--text-muted)",
    display: "flex",
    gap: 10,
    flexWrap: "wrap",
  } satisfies CSSProperties,
} as const;
