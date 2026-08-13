import type { CSSProperties } from "react";

/** Co-located styles for the DiffTab header. */
export const ds = {
  headerRight: { display: "flex", alignItems: "center", gap: 8 } satisfies CSSProperties,
  diffStat: {
    fontSize: 12.5,
    color: "var(--text-muted)",
    marginBottom: 14,
    marginTop: -6,
  } satisfies CSSProperties,
  add: { color: "var(--code-add-text)" } satisfies CSSProperties,
  del: { color: "var(--code-del-text)" } satisfies CSSProperties,
} as const;
