import type { CSSProperties } from "react";

/** Co-located styles for the Skill editor's Stats tab. */
export const s = {
  wrap: { maxWidth: 940 } satisfies CSSProperties,
  h2: { fontSize: 16, fontWeight: 700 } satisfies CSSProperties,
  subtitle: {
    fontSize: 13,
    color: "var(--text-secondary)",
    marginBottom: 18,
    maxWidth: 720,
    lineHeight: 1.5,
  } satisfies CSSProperties,
  tiles: { display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 } satisfies CSSProperties,
  panels: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
    gap: 12,
  } satisfies CSSProperties,
  panel: {
    border: "1px solid var(--border)",
    borderRadius: 9,
    background: "var(--bg-elevated)",
    padding: 18,
  } satisfies CSSProperties,
  panelHeading: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: 0.4,
    textTransform: "uppercase",
    color: "var(--text-muted)",
    marginBottom: 14,
  } satisfies CSSProperties,
  agentRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    border: "1px solid var(--border)",
    borderRadius: 8,
    padding: "10px 12px",
    marginBottom: 8,
  } satisfies CSSProperties,
  agentName: { fontSize: 13.5, fontWeight: 600, flex: 1 } satisfies CSSProperties,
  note: { fontSize: 12.5, color: "var(--text-muted)" } satisfies CSSProperties,
} as const;
