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

  statRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 16,
    fontSize: 12,
    color: "var(--text-muted)",
  } satisfies CSSProperties,

  stat: { display: "inline-flex", alignItems: "center", gap: 6 } satisfies CSSProperties,
  statNum: { color: "var(--text-primary)", fontWeight: 600 } satisfies CSSProperties,

  tree: { display: "flex", flexDirection: "column", gap: 4 } satisfies CSSProperties,

  symbolRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    padding: "5px 4px",
    background: "transparent",
    border: "none",
    borderRadius: 6,
    cursor: "pointer",
    textAlign: "left",
    color: "var(--text-primary)",
    fontSize: 13,
  } satisfies CSSProperties,

  symbolName: {
    fontFamily: "var(--font-mono, ui-monospace, monospace)",
    color: "var(--text-primary)",
  } satisfies CSSProperties,

  callerCount: { marginLeft: "auto", fontSize: 12, color: "var(--text-muted)" } satisfies CSSProperties,

  /* Callers are indented under their symbol with a rule, so a long file list
     still reads as belonging to the symbol above it. */
  callerList: {
    margin: "2px 0 8px 9px",
    padding: "2px 0 2px 14px",
    borderLeft: "1px solid var(--border)",
    listStyle: "none",
    display: "flex",
    flexDirection: "column",
    gap: 3,
  } satisfies CSSProperties,

  caller: {
    fontSize: 12,
    fontFamily: "var(--font-mono, ui-monospace, monospace)",
    color: "var(--text-secondary)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  } satisfies CSSProperties,

  chipRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 6,
    margin: "2px 0 4px 23px",
  } satisfies CSSProperties,

  chip: (color: string): CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    fontSize: 11,
    fontFamily: "var(--font-mono, ui-monospace, monospace)",
    padding: "2px 8px",
    borderRadius: 6,
    border: `1px solid color-mix(in srgb, ${color} 35%, transparent)`,
    background: `color-mix(in srgb, ${color} 12%, transparent)`,
    color,
    whiteSpace: "nowrap",
  }),

  history: { borderTop: "1px solid var(--border)", paddingTop: 12 } satisfies CSSProperties,

  historyToggle: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    padding: 0,
    background: "transparent",
    border: "none",
    cursor: "pointer",
    color: "var(--text-secondary)",
    fontSize: 13,
    textAlign: "left",
  } satisfies CSSProperties,

  historyList: {
    margin: "10px 0 0",
    padding: 0,
    listStyle: "none",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  } satisfies CSSProperties,

  historyItem: { fontSize: 12, color: "var(--text-secondary)" } satisfies CSSProperties,
  historyMeta: { fontSize: 11, color: "var(--text-muted)" } satisfies CSSProperties,
  empty: { fontSize: 13, color: "var(--text-muted)" } satisfies CSSProperties,
} as const;
