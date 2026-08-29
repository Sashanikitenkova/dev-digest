import type React from "react";

export const s: Record<string, React.CSSProperties> = {
  card: {
    display: "flex",
    gap: 18,
    padding: 18,
    borderRadius: 12,
    border: "1px solid var(--border)",
    borderLeft: "3px solid var(--border)",
    background: "var(--bg-elevated)",
    marginBottom: 14,
  },
  // Accepted rows carry the accent rail from the mockup; rejected ones recede
  // rather than disappear, so a mis-click is visible and reversible.
  cardAccepted: { borderLeftColor: "var(--ok)" },
  cardRejected: { opacity: 0.5, borderLeftColor: "var(--text-muted)" },

  main: { flex: 1, minWidth: 0 },
  ruleRow: { display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12 },
  category: {
    flexShrink: 0,
    fontSize: 10.5,
    letterSpacing: 0.4,
    textTransform: "uppercase",
    color: "var(--text-muted)",
    fontWeight: 600,
  },
  rule: {
    margin: 0,
    fontSize: 14.5,
    fontWeight: 600,
    fontStyle: "italic",
    color: "var(--text-primary)",
    lineHeight: 1.4,
  },

  evidence: {
    borderRadius: 8,
    border: "1px solid var(--border)",
    background: "var(--bg-base)",
    overflow: "hidden",
  },
  evidenceHead: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 10px",
    borderBottom: "1px solid var(--border)",
  },
  evidenceLink: {
    display: "inline-flex",
    alignItems: "center",
    fontFamily: "var(--font-mono)",
    fontSize: 12,
    color: "var(--text-secondary)",
    textDecoration: "none",
  },
  evidencePath: { fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-secondary)" },
  copyBtn: {
    marginLeft: "auto",
    display: "grid",
    placeItems: "center",
    width: 24,
    height: 24,
    borderRadius: 6,
    border: "none",
    background: "transparent",
    color: "var(--text-muted)",
    cursor: "pointer",
  },
  snippet: {
    margin: 0,
    padding: "10px 12px",
    fontFamily: "var(--font-mono)",
    fontSize: 12,
    lineHeight: 1.6,
    color: "var(--text-primary)",
    // Long lines scroll inside the block instead of widening the card.
    overflowX: "auto",
    whiteSpace: "pre",
  },

  confidenceRow: { display: "flex", alignItems: "center", gap: 10, marginTop: 12 },
  confidenceLabel: { fontSize: 11.5, color: "var(--text-muted)" },
  confidenceBar: { width: 110 },
  confidencePct: { fontSize: 11.5, color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" },

  actions: { display: "flex", flexDirection: "column", gap: 8, flexShrink: 0, width: 150 },
};
