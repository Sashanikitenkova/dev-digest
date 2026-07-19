import type { CSSProperties } from "react";

/** Co-located styles for SkillEditor. */
export const s = {
  wrap: { display: "flex", flexDirection: "column", minHeight: 0 } satisfies CSSProperties,
  tabsBar: { flexShrink: 0 } satisfies CSSProperties,
  body: { padding: "22px 28px 44px", maxWidth: 820 } satisfies CSSProperties,
} as const;
