import type { CSSProperties } from "react";

/** Co-located styles for ImportSkillDrawer. */
export const s = {
  fileRow: { display: "flex", alignItems: "center", gap: 12, marginBottom: 4 } satisfies CSSProperties,
  fileName: { fontSize: 13, color: "var(--text-secondary)" } satisfies CSSProperties,
  hiddenInput: { display: "none" } satisfies CSSProperties,
  error: { fontSize: 13, color: "var(--crit)", marginTop: 10 } satisfies CSSProperties,
  previewWrap: { marginTop: 22 } satisfies CSSProperties,
  field: { marginBottom: 14 } satisfies CSSProperties,
  fieldLabel: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: "var(--text-muted)",
    marginBottom: 5,
  } as CSSProperties,
  fieldValue: { fontSize: 13.5, color: "var(--text-primary)", lineHeight: 1.5 } satisfies CSSProperties,
  body: {
    fontSize: 12.5,
    lineHeight: 1.55,
    whiteSpace: "pre-wrap",
    padding: "10px 12px",
    borderRadius: 7,
    border: "1px solid var(--border)",
    background: "var(--bg-elevated)",
    maxHeight: 220,
    overflow: "auto",
  } satisfies CSSProperties,
  noticeBase: {
    display: "flex",
    gap: 10,
    padding: "10px 12px",
    borderRadius: 7,
    fontSize: 12.5,
    lineHeight: 1.5,
    marginTop: 16,
  } satisfies CSSProperties,
  skipped: {
    border: "1px solid var(--border-strong)",
    background: "var(--bg-hover)",
    color: "var(--text-secondary)",
  } satisfies CSSProperties,
  skippedList: { margin: "6px 0 0", paddingLeft: 18 } satisfies CSSProperties,
  skippedNote: { fontSize: 12, color: "var(--text-muted)", marginTop: 8, lineHeight: 1.45 } satisfies CSSProperties,
  trust: {
    border: "1px solid var(--border-strong)",
    background: "var(--bg-hover)",
    color: "var(--text-secondary)",
  } satisfies CSSProperties,
  footer: { display: "flex", alignItems: "center", gap: 12, justifyContent: "flex-end" } satisfies CSSProperties,
} as const;
