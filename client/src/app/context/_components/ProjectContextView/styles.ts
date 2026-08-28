import type React from "react";

/* Not `Record<string, CSSProperties>`: `row` is a function of the selected
   state, which that index signature cannot express. `satisfies` per entry keeps
   the same type-checking without flattening the shape. */
export const s = {
  page: { padding: "26px 30px", maxWidth: 1080, margin: "0 auto" } satisfies React.CSSProperties,
  header: { display: "flex", alignItems: "flex-start", gap: 16, marginBottom: 22 } satisfies React.CSSProperties,
  headerText: { flex: 1, minWidth: 0 } satisfies React.CSSProperties,
  h1: { margin: 0, fontSize: 22, fontWeight: 700, color: "var(--text-primary)" } satisfies React.CSSProperties,
  repo: { fontFamily: "var(--font-mono)", color: "var(--accent)" } satisfies React.CSSProperties,
  subtitle: { margin: "6px 0 0", fontSize: 13, color: "var(--text-muted)", lineHeight: 1.5 } satisfies React.CSSProperties,

  split: { display: "grid", gridTemplateColumns: "minmax(0, 380px) minmax(0, 1fr)", gap: 18 } satisfies React.CSSProperties,
  list: { display: "flex", flexDirection: "column", gap: 8, minWidth: 0 } satisfies React.CSSProperties,
  row: (selected: boolean): React.CSSProperties => ({
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 12px",
    borderRadius: 8,
    border: "1px solid " + (selected ? "var(--accent)" : "var(--border)"),
    background: "var(--bg-surface)",
    cursor: "pointer",
    textAlign: "left",
    width: "100%",
  }),
  rowMain: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 } satisfies React.CSSProperties,
  path: {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--text-primary)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  } satisfies React.CSSProperties,
  meta: { fontSize: 12, color: "var(--text-muted)" } satisfies React.CSSProperties,

  pane: {
    minWidth: 0,
    border: "1px solid var(--border)",
    borderRadius: 10,
    background: "var(--bg-surface)",
    padding: "16px 18px",
    fontSize: 13,
    color: "var(--text-primary)",
  } satisfies React.CSSProperties,
  paneTitle: {
    margin: "0 0 10px",
    fontSize: 13,
    fontWeight: 600,
    fontFamily: "var(--font-mono)",
    color: "var(--accent)",
    wordBreak: "break-all",
  } satisfies React.CSSProperties,
  paneHint: { fontSize: 13, color: "var(--text-muted)" } satisfies React.CSSProperties,
  footer: { marginTop: 18, fontSize: 12, color: "var(--text-muted)" } satisfies React.CSSProperties,
  errorBar: {
    padding: "10px 14px",
    borderRadius: 8,
    marginBottom: 16,
    fontSize: 13,
    lineHeight: 1.5,
    border: "1px solid var(--crit)",
    color: "var(--crit)",
  } satisfies React.CSSProperties,
} as const;
