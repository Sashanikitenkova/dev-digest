import type { CSSProperties } from "react";
import type { DiffKind } from "./helpers";

const DIFF_COLORS: Record<DiffKind, { color: string; background: string }> = {
  add: { color: "var(--ok, var(--accent))", background: "var(--accent-bg)" },
  del: { color: "var(--crit)", background: "var(--crit-bg)" },
  same: { color: "var(--text-secondary)", background: "transparent" },
};

/** Co-located styles for the Skill editor's Versions tab. */
export const s = {
  wrap: { maxWidth: 720 } satisfies CSSProperties,
  h2: { fontSize: 16, fontWeight: 700 } satisfies CSSProperties,
  subtitle: { fontSize: 13, color: "var(--text-secondary)", marginBottom: 18 } satisfies CSSProperties,
  row: {
    border: "1px solid var(--border)",
    borderRadius: 8,
    background: "var(--bg-elevated)",
    padding: 14,
    marginBottom: 10,
  } satisfies CSSProperties,
  rowHeader: { display: "flex", alignItems: "center", gap: 10 } satisfies CSSProperties,
  when: { fontSize: 12.5, color: "var(--text-muted)", flex: 1 } satisfies CSSProperties,
  actions: { display: "flex", alignItems: "center", gap: 8 } satisfies CSSProperties,
  diff: {
    marginTop: 12,
    borderTop: "1px solid var(--border)",
    paddingTop: 10,
    fontSize: 12,
    lineHeight: 1.5,
    maxHeight: 320,
    overflow: "auto",
  } satisfies CSSProperties,
  diffLine: (kind: DiffKind): CSSProperties => ({
    whiteSpace: "pre-wrap",
    padding: "0 6px",
    ...DIFF_COLORS[kind],
  }),
  note: { fontSize: 12.5, color: "var(--text-muted)", marginTop: 8 } satisfies CSSProperties,
  error: { fontSize: 13, color: "var(--crit)" } satisfies CSSProperties,
} as const;
