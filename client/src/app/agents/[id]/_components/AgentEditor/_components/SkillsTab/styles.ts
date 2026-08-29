import type { CSSProperties } from "react";
import { TAB_MAX_WIDTH } from "./constants";

/** Co-located styles for the agent editor's Skills tab. */
export const s = {
  wrap: { maxWidth: TAB_MAX_WIDTH } satisfies CSSProperties,
  header: { display: "flex", alignItems: "center", gap: 12, marginBottom: 10 } satisfies CSSProperties,
  h2: { fontSize: 18, fontWeight: 700 } satisfies CSSProperties,
  headerRight: { marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 } satisfies CSSProperties,
  filterBox: { width: 220 } satisfies CSSProperties,
  caption: {
    fontSize: 13,
    lineHeight: 1.6,
    color: "var(--text-muted)",
    marginBottom: 18,
  } satisfies CSSProperties,
  list: { display: "flex", flexDirection: "column", gap: 8 } satisfies CSSProperties,
  row: (dim: boolean, dropTarget: boolean): CSSProperties => ({
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "10px 12px",
    borderRadius: 8,
    border: "1px solid " + (dropTarget ? "var(--accent)" : "var(--border)"),
    background: "var(--bg-surface)",
    opacity: dim ? 0.55 : 1,
  }),
  handle: {
    display: "inline-flex",
    color: "var(--text-muted)",
    cursor: "grab",
    flexShrink: 0,
  } satisfies CSSProperties,
  name: { fontSize: 14, fontWeight: 600, color: "var(--text-primary)" } satisfies CSSProperties,
  description: {
    fontSize: 12,
    color: "var(--text-muted)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  } satisfies CSSProperties,
  main: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 } satisfies CSSProperties,
  rowRight: { display: "flex", alignItems: "center", gap: 6, flexShrink: 0 } satisfies CSSProperties,
  noMatch: { fontSize: 13, color: "var(--text-muted)", padding: "18px 2px" } satisfies CSSProperties,
  error: { fontSize: 13, color: "var(--crit)", marginBottom: 12 } satisfies CSSProperties,
} as const;
