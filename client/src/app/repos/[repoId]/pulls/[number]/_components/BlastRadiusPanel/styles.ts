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

  /* Indirect (2-hop) impact reads as present-but-secondary, not as noise with
     the same weight as a direct hit. */
  chipDim: { opacity: 0.6, borderStyle: "dashed" } satisfies CSSProperties,

  chipMore: {
    fontSize: 11,
    padding: "2px 8px",
    borderRadius: 6,
    border: "1px dashed var(--border)",
    background: "transparent",
    color: "var(--text-muted)",
    cursor: "pointer",
    whiteSpace: "nowrap",
  } satisfies CSSProperties,

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

  /* Header row: stats on the left, the Tree/Graph switch pinned right. */
  headRow: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    flexWrap: "wrap",
  } satisfies CSSProperties,

  toggle: {
    marginLeft: "auto",
    display: "inline-flex",
    border: "1px solid var(--border)",
    borderRadius: 6,
    overflow: "hidden",
  } satisfies CSSProperties,

  toggleBtn: (active: boolean): CSSProperties => ({
    padding: "3px 12px",
    fontSize: 12,
    border: "none",
    cursor: "pointer",
    background: active ? "var(--bg-subtle, rgba(255,255,255,0.08))" : "transparent",
    color: active ? "var(--text-primary)" : "var(--text-muted)",
    fontWeight: active ? 600 : 400,
  }),

  /* Sits ABOVE the tree, never instead of it: a partial index still produced
     real results, and hiding them would trade one wrong claim for another. */
  banner: (color: string): CSSProperties => ({
    display: "flex",
    flexDirection: "column",
    gap: 4,
    padding: "10px 12px",
    borderRadius: 6,
    border: `1px solid color-mix(in srgb, ${color} 35%, transparent)`,
    background: `color-mix(in srgb, ${color} 10%, transparent)`,
    fontSize: 12,
  }),

  bannerHead: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    color: "var(--text-primary)",
    fontWeight: 600,
  } satisfies CSSProperties,

  bannerBody: { color: "var(--text-secondary)", lineHeight: 1.5 } satisfies CSSProperties,
  bannerMeta: { color: "var(--text-muted)", fontSize: 11 } satisfies CSSProperties,

  bannerCta: {
    alignSelf: "flex-start",
    marginTop: 2,
    padding: 0,
    background: "none",
    border: "none",
    cursor: "pointer",
    fontSize: 12,
    color: "var(--accent-text, #6ea8fe)",
    textDecoration: "underline",
    textUnderlineOffset: 2,
  } satisfies CSSProperties,
} as const;

/** Graph-view styles, kept separate so the tree's names stay short. */
export const g = {
  scroll: { overflowX: "auto", paddingTop: 4 } satisfies CSSProperties,
  svg: { display: "block", minWidth: "100%" } satisfies CSSProperties,

  nodeText: {
    fontSize: 11,
    fontFamily: "var(--font-mono, ui-monospace, monospace)",
    fill: "var(--text-secondary)",
  } satisfies CSSProperties,

  legend: {
    display: "flex",
    flexWrap: "wrap",
    gap: 14,
    marginTop: 10,
    fontSize: 11,
    color: "var(--text-muted)",
  } satisfies CSSProperties,

  legendItem: { display: "inline-flex", alignItems: "center", gap: 5 } satisfies CSSProperties,

  dot: (color: string): CSSProperties => ({
    width: 7,
    height: 7,
    borderRadius: "50%",
    background: color,
    display: "inline-block",
  }),

  empty: { fontSize: 13, color: "var(--text-muted)" } satisfies CSSProperties,
} as const;
