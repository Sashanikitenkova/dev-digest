import type { CSSProperties } from "react";

/** Co-located styles for the Skill editor's Preview tab. */
export const s = {
  wrap: { maxWidth: 720 } satisfies CSSProperties,
  header: { display: "flex", alignItems: "center", gap: 10, marginBottom: 4 } satisfies CSSProperties,
  h2: { fontSize: 16, fontWeight: 700 } satisfies CSSProperties,
  subtitle: { fontSize: 13, color: "var(--text-secondary)", marginBottom: 18 } satisfies CSSProperties,
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
  rendered: {
    fontSize: 14,
    padding: "18px 20px",
    borderRadius: 9,
    border: "1px solid var(--border)",
    background: "var(--bg-surface)",
  } satisfies CSSProperties,
} as const;
