import type React from "react";

const bar: React.CSSProperties = {
  padding: "10px 14px",
  borderRadius: 8,
  marginBottom: 16,
  fontSize: 13,
  lineHeight: 1.5,
  border: "1px solid var(--border)",
};

export const s: Record<string, React.CSSProperties> = {
  page: { padding: "26px 30px", maxWidth: 1080, margin: "0 auto" },
  header: { display: "flex", alignItems: "flex-start", gap: 16, marginBottom: 22 },
  headerText: { flex: 1, minWidth: 0 },
  h1: { margin: 0, fontSize: 22, fontWeight: 700, color: "var(--text-primary)" },
  repo: { fontFamily: "var(--font-mono)", color: "var(--accent)" },
  subtitle: { margin: "6px 0 0", fontSize: 13, color: "var(--text-muted)", lineHeight: 1.5 },

  toolbar: { display: "flex", alignItems: "center", gap: 12, marginBottom: 16 },
  count: { fontSize: 12.5, color: "var(--text-muted)", marginLeft: "auto" },

  errorBar: { ...bar, borderColor: "var(--crit)", color: "var(--crit)" },
  warnBar: { ...bar, borderColor: "var(--warn)", color: "var(--warn)" },
  noticeBar: { ...bar, color: "var(--text-muted)", background: "var(--bg-hover)" },
};
