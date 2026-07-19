import type { CSSProperties } from "react";

/** Co-located styles for the Skill editor's Config tab. */
export const s = {
  wrap: { maxWidth: 720 } satisfies CSSProperties,
  header: { display: "flex", alignItems: "center", marginBottom: 18 } satisfies CSSProperties,
  h2: { fontSize: 16, fontWeight: 700 } satisfies CSSProperties,
  enabledLabel: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginLeft: "auto",
    fontSize: 13,
    color: "var(--text-secondary)",
  } satisfies CSSProperties,
  actions: { display: "flex", alignItems: "center", gap: 12, marginTop: 6 } satisfies CSSProperties,
  savedNote: { fontSize: 12.5, color: "var(--text-muted)" } satisfies CSSProperties,
  errorNote: { fontSize: 12.5, color: "var(--crit)" } satisfies CSSProperties,
  untrusted: {
    display: "flex",
    gap: 10,
    padding: "10px 12px",
    borderRadius: 7,
    border: "1px solid var(--border-strong)",
    background: "var(--bg-hover)",
    fontSize: 12.5,
    lineHeight: 1.5,
    color: "var(--text-secondary)",
    marginBottom: 18,
  } satisfies CSSProperties,
} as const;
