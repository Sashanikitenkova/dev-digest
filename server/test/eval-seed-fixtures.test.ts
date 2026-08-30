import { describe, it, expect } from 'vitest';
import { DEMO_PATCHES, DEMO_FINDINGS } from '../src/db/seed.js';
import { parseUnifiedDiff } from '../src/adapters/git/diff-parser.js';
import { groundFindings } from '@devdigest/reviewer-core';
import type { Finding } from '@devdigest/shared';

/**
 * The seeded demo dataset has to survive the grounding gate.
 *
 * A seeded finding whose line falls outside its file's hunk is invisible to the
 * user (the gate drops it) and can never become an eval case — the demo would
 * simply be broken, silently, with no error anywhere. This pins the invariant so
 * editing a patch without moving the findings fails here instead of in a demo.
 */

/** Same reconstruction `diffFromPrFiles` performs from `pr_files.patch`. */
function demoDiff() {
  const parts: string[] = [];
  for (const [path, patch] of Object.entries(DEMO_PATCHES)) {
    parts.push(`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, patch);
  }
  return parseUnifiedDiff(parts.join('\n'));
}

describe('seeded demo fixtures', () => {
  it('reconstructs a diff covering every file the findings cite', () => {
    const diff = demoDiff();
    const paths = new Set(diff.files.map((f) => f.path));
    for (const f of DEMO_FINDINGS) expect(paths, `${f.file} missing from diff`).toContain(f.file);
  });

  it('cites only lines inside a real hunk — every finding survives the gate', () => {
    const diff = demoDiff();
    const findings = DEMO_FINDINGS.map((f, i) => ({
      id: `seed-${i}`,
      severity: f.severity,
      category: f.category,
      title: f.title,
      file: f.file,
      start_line: f.startLine,
      end_line: f.endLine,
      rationale: f.rationale,
      suggestion: f.suggestion,
      confidence: f.confidence,
      kind: 'finding',
    })) as unknown as Finding[];

    const { kept, dropped } = groundFindings(findings, diff);
    expect(
      dropped.map((d) => `${d.finding.file}:${d.finding.start_line} — ${d.reason}`),
      'a seeded finding cites a line outside its hunk',
    ).toEqual([]);
    expect(kept).toHaveLength(DEMO_FINDINGS.length);
  });

  it('provides at least 8 decided findings, of both kinds (SPEC-03 acceptance)', () => {
    const accepted = DEMO_FINDINGS.filter((f) => f.decision === 'accepted');
    const dismissed = DEMO_FINDINGS.filter((f) => f.decision === 'dismissed');
    expect(DEMO_FINDINGS.length).toBeGreaterThanOrEqual(8);
    // Both expectation kinds must be reachable by clicking, and precision needs
    // must_not_flag cases to have anything to measure against.
    expect(accepted.length).toBeGreaterThan(0);
    expect(dismissed.length).toBeGreaterThan(0);
  });

  it('gives every finding exactly one decision', () => {
    for (const f of DEMO_FINDINGS) {
      expect(['accepted', 'dismissed']).toContain(f.decision);
    }
  });
});
