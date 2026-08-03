import type { ConventionCandidate } from "@devdigest/shared";

/**
 * `src/a.ts:12-18` when the snippet spans lines, `src/a.ts:12` when it doesn't.
 * The end line is derived from the snippet rather than stored: the grounding
 * gate already proved those lines are contiguous from `evidence_line`.
 */
export function evidenceLabel(c: ConventionCandidate): string {
  if (!c.evidence_path) return "";
  if (!c.evidence_line) return c.evidence_path;
  const span = c.evidence_snippet.split("\n").filter((l) => l.trim().length > 0).length;
  const end = c.evidence_line + Math.max(0, span - 1);
  return end > c.evidence_line
    ? `${c.evidence_path}:${c.evidence_line}-${end}`
    : `${c.evidence_path}:${c.evidence_line}`;
}

/** Green ≥ 0.85, amber ≥ 0.6, muted below — the mockup's three bands. */
export function confidenceColor(confidence: number): string {
  if (confidence >= 0.85) return "var(--ok)";
  if (confidence >= 0.6) return "var(--warn)";
  return "var(--text-muted)";
}
