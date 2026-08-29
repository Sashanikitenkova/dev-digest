import type { ConventionCandidate } from '@devdigest/shared';
import type { ConventionRow } from './repository.js';
import { MAX_LINES_PER_FILE, SNIPPET_MATCH_WINDOW } from './constants.js';

/**
 * Pure helpers for the conventions extractor: sample assembly, the evidence
 * grounding gate, and row → DTO mapping. Kept free of I/O and of the container
 * so the grounding rules can be unit-tested directly.
 */

/** One sampled file, already read off the clone. */
export interface FileSample {
  path: string;
  lines: string[];
}

/**
 * Render the sampled files as a LINE-NUMBERED block.
 *
 * The numbering is not cosmetic: the model is asked to cite `evidence.line`,
 * and the grounding gate rejects any candidate whose line doesn't match. With
 * unnumbered text the model can only guess a line, so nearly every candidate
 * would be dropped and the feature would look broken.
 */
export function renderSamples(samples: FileSample[], maxChars: number): string {
  const parts: string[] = [];
  let used = 0;
  for (const s of samples) {
    const body = s.lines.map((l, i) => `${i + 1}: ${l}`).join('\n');
    const block = `--- FILE: ${s.path} ---\n${body}\n`;
    if (used + block.length > maxChars) break;
    parts.push(block);
    used += block.length;
  }
  return parts.join('\n');
}

/**
 * Normalize for comparison: collapse whitespace runs, trim. Case is preserved —
 * casing is itself a convention (`camelCase` vs `snake_case`), so folding it
 * would let a candidate "ground" against a line it misquotes.
 */
export function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export interface GroundingResult {
  ok: boolean;
  /** Why it was dropped — surfaced in logs so a 0-kept run is diagnosable. */
  reason?: 'unknown-file' | 'line-out-of-range' | 'snippet-mismatch' | 'empty-snippet';
  /** Last line of the matched range, for the `file:line-range` the UI renders. */
  endLine?: number;
}

/**
 * The grounding gate. A candidate survives only if its evidence points at code
 * that ACTUALLY EXISTS in the sampled file at (or very near) the cited line.
 *
 * Matching is whitespace-normalized rather than exact — the model reliably
 * reflows indentation when quoting — and scans a small window around the cited
 * line, because an off-by-one on a multi-line snippet is a citation nit, not a
 * fabrication. A snippet that appears NOWHERE in the window is a fabrication,
 * and is dropped.
 */
export function groundCandidate(
  candidate: { evidence_path: string; evidence_line: number; evidence_snippet: string },
  byPath: Map<string, FileSample>,
): GroundingResult {
  const file = byPath.get(candidate.evidence_path);
  if (!file) return { ok: false, reason: 'unknown-file' };

  const snippetLines = candidate.evidence_snippet
    .split('\n')
    .map(normalize)
    .filter((l) => l.length > 0);
  if (snippetLines.length === 0) return { ok: false, reason: 'empty-snippet' };

  const line = candidate.evidence_line;
  if (!Number.isInteger(line) || line < 1 || line > file.lines.length) {
    return { ok: false, reason: 'line-out-of-range' };
  }

  // Search a window around the cited line for the snippet's FIRST line, then
  // require the remaining snippet lines to follow in order from there.
  const from = Math.max(0, line - 1 - SNIPPET_MATCH_WINDOW);
  const to = Math.min(file.lines.length - 1, line - 1 + SNIPPET_MATCH_WINDOW);
  const norm = file.lines.map(normalize);

  for (let start = from; start <= to; start++) {
    if (!lineMatches(norm[start] ?? '', snippetLines[0]!)) continue;
    let cursor = start;
    let matched = 1;
    for (let i = 1; i < snippetLines.length; i++) {
      const next = cursor + 1;
      if (next >= norm.length || !lineMatches(norm[next] ?? '', snippetLines[i]!)) break;
      cursor = next;
      matched++;
    }
    if (matched === snippetLines.length) return { ok: true, endLine: cursor + 1 };
  }
  return { ok: false, reason: 'snippet-mismatch' };
}

/**
 * Containment in EITHER direction: the model often quotes a fragment of a long
 * line, and occasionally pads a short one. Both still identify the same code.
 */
function lineMatches(fileLine: string, snippetLine: string): boolean {
  if (fileLine === snippetLine) return true;
  if (snippetLine.length === 0 || fileLine.length === 0) return false;
  return fileLine.includes(snippetLine) || snippetLine.includes(fileLine);
}

/** Truncate a file to the per-file line cap. */
export function capLines(source: string): string[] {
  return source.split('\n').slice(0, MAX_LINES_PER_FILE);
}

export function toConventionDto(row: ConventionRow): ConventionCandidate {
  return {
    id: row.id,
    category: row.category,
    rule: row.rule,
    evidence_path: row.evidencePath ?? '',
    evidence_line: row.evidenceLine,
    evidence_snippet: row.evidenceSnippet ?? '',
    confidence: row.confidence ?? 0,
    status: row.status,
    created_at: row.createdAt.toISOString(),
  };
}
