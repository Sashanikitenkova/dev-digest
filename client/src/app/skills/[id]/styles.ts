import type { CSSProperties } from "react";

/** Co-located styles for the /skills/:id shell (left list + editor pane). */
export const s = {
  layout: { display: "flex", height: "calc(100vh - 52px)" } satisfies CSSProperties,
  leftPane: {
    width: 280,
    flexShrink: 0,
    borderRight: "1px solid var(--border)",
    display: "flex",
    flexDirection: "column",
    background: "var(--bg-surface)",
  } satisfies CSSProperties,
  leftHeader: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "16px 16px 12px",
  } satisfies CSSProperties,
  leftTitle: { fontSize: 18, fontWeight: 700, flex: 1 } satisfies CSSProperties,
  leftList: { flex: 1, overflow: "auto", padding: "0 12px 12px" } satisfies CSSProperties,
  loading: {
    flex: 1,
    padding: 28,
    display: "flex",
    flexDirection: "column",
    gap: 16,
  } satisfies CSSProperties,
  editorPane: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    minHeight: 0,
  } satisfies CSSProperties,
  editorHeader: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "16px 28px 0",
    flexShrink: 0,
  } satisfies CSSProperties,
  editorTitle: { fontSize: 18, fontWeight: 700 } satisfies CSSProperties,
  headerActions: { marginLeft: "auto" } satisfies CSSProperties,
  editorScroll: { flex: 1, minHeight: 0, overflow: "auto" } satisfies CSSProperties,
} as const;
