import type { CSSProperties } from "react";

export const s = {
  /* The banner and its footnote read as one card, so the footnote is pulled up
     under the banner's bottom border rather than floated as a separate block. */
  wrap: { position: "relative" } satisfies CSSProperties,
  footnote: {
    display: "flex",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: 10,
    marginTop: -10,
    padding: "0 18px 10px",
    fontSize: 12,
    color: "var(--text-muted)",
  } satisfies CSSProperties,
  cost: { display: "inline-flex", alignItems: "center", gap: 4 } satisfies CSSProperties,
  tokens: { color: "var(--text-muted)", opacity: 0.8 } satisfies CSSProperties,
} as const;
