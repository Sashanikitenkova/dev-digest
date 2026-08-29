import type { CSSProperties } from "react";

export const s = {
  /* Intent and blast radius sit side by side on a wide screen and stack below
     ~900px. `minmax(0, 1fr)` rather than `1fr`: the blast panel renders long
     file paths, and a bare `1fr` track refuses to shrink below its content,
     which would push the grid wider than the page. */
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(min(420px, 100%), 1fr))",
    gap: 16,
    alignItems: "start",
  } satisfies CSSProperties,
  descriptionBox: {
    border: "1px solid var(--border)",
    borderRadius: 8,
    background: "var(--bg-elevated)",
    padding: 18,
    fontSize: 14,
    color: "var(--text-secondary)",
    whiteSpace: "pre-wrap",
    lineHeight: 1.55,
  } satisfies CSSProperties,
} as const;
