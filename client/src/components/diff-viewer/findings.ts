/* Finding support for the DiffViewer (Smart Diff). Pure helpers that anchor
   review findings to rendered diff lines, mirroring what comments.ts does for
   GitHub review comments. */
import type { CSSProperties } from "react";
import type { FindingRecord } from "@devdigest/shared";
import { SEV, type Severity } from "@devdigest/ui";
import type { Line } from "./helpers";

/** Worst first — a file's badge takes the colour of its most severe finding. */
export const SEVERITY_RANK: Record<Severity, number> = {
  CRITICAL: 0,
  WARNING: 1,
  SUGGESTION: 2,
  INFO: 3,
};

/**
 * The word shown next to a flagged line. Everywhere else in the studio a
 * CRITICAL finding is called a "blocker" (see ReviewRunAccordion), so the diff
 * says the same thing rather than inventing a third vocabulary.
 */
export const SEVERITY_LABEL: Record<Severity, string> = {
  CRITICAL: "blocker",
  WARNING: "warning",
  SUGGESTION: "suggestion",
  INFO: "info",
};

const severityOf = (f: FindingRecord): Severity => f.severity as Severity;

/** Findings bucketed by file path — built once per PR, read by every FileCard. */
export function findingsByPath(findings: FindingRecord[]): Map<string, FindingRecord[]> {
  const map = new Map<string, FindingRecord[]>();
  for (const f of findings) {
    map.set(f.file, [...(map.get(f.file) ?? []), f]);
  }
  return map;
}

/** The most severe finding in a list — decides the badge colour. */
export function worstSeverity(findings: FindingRecord[]): Severity | null {
  let worst: Severity | null = null;
  for (const f of findings) {
    const sev = severityOf(f);
    if (worst === null || SEVERITY_RANK[sev] < SEVERITY_RANK[worst]) worst = sev;
  }
  return worst;
}

/**
 * Findings anchored to each rendered line, keyed by `start_line`.
 *
 * Findings carry no LEFT/RIGHT side — they always cite the post-change file —
 * so they anchor to `newNo` only. A finding whose line is not in the rendered
 * patch (context trimmed, or the file changed since the review) is returned in
 * `unanchored` rather than being silently dropped, the same promise
 * `partitionThreads` makes for comments.
 */
export function anchorFindings(
  findings: FindingRecord[],
  lines: Line[],
): { byLine: Map<number, FindingRecord[]>; unanchored: FindingRecord[] } {
  const rendered = new Set<number>();
  for (const ln of lines) {
    if (ln.newNo != null) rendered.add(ln.newNo);
  }
  const byLine = new Map<number, FindingRecord[]>();
  const unanchored: FindingRecord[] = [];
  for (const f of findings) {
    if (rendered.has(f.start_line)) {
      byLine.set(f.start_line, [...(byLine.get(f.start_line) ?? []), f]);
    } else {
      unanchored.push(f);
    }
  }
  return { byLine, unanchored };
}

/** The line a file's findings badge should jump to (its first flagged line). */
export function firstFindingLine(findings: FindingRecord[]): number | null {
  if (findings.length === 0) return null;
  return Math.min(...findings.map((f) => f.start_line));
}

// ---- styles ----
export const fs = {
  /** Severity chip sitting at the right edge of a flagged code line. */
  lineTag: (severity: Severity): CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    marginLeft: "auto",
    paddingRight: 12,
    fontSize: 11.5,
    fontWeight: 600,
    color: SEV[severity].c,
    whiteSpace: "nowrap",
    flexShrink: 0,
  }),
  /** Coloured rail marking a flagged row; longhand only (never mix with `border`). */
  flaggedRow: (severity: Severity): CSSProperties => ({
    borderLeftWidth: 2,
    borderLeftStyle: "solid",
    borderLeftColor: SEV[severity].c,
  }),
  badge: (severity: Severity): CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    padding: "2px 8px",
    borderRadius: 5,
    border: "none",
    fontSize: 11.5,
    fontWeight: 600,
    color: SEV[severity].c,
    background: SEV[severity].bg,
    cursor: "pointer",
    whiteSpace: "nowrap",
  }),
} as const;
