import { describe, it, expect } from 'vitest';
import {
  groundCandidate,
  normalize,
  renderSamples,
  capLines,
  type FileSample,
} from '../src/modules/conventions/helpers.js';

/**
 * The conventions grounding gate — the rule that the MODEL PROPOSES but CODE
 * DECIDES. A candidate is persisted only if its cited file/line/snippet really
 * exists in the sampled source. These tests pin the two failure modes that
 * matter in opposite directions:
 *
 *   - too strict → real conventions get dropped and the feature looks broken;
 *   - too loose  → a fabricated rule gets merged into a Skill and injected
 *                  into every future review.
 */

const FILE: FileSample = {
  path: 'src/db/schema/_shared.ts',
  lines: [
    "import { timestamp } from 'drizzle-orm/pg-core';",
    '',
    '/** Standard created_at column. */',
    "export const now = () =>",
    "  timestamp('created_at', { withTimezone: true }).defaultNow().notNull();",
    '',
    'export const OTHER = 1;',
  ],
};

const byPath = new Map([[FILE.path, FILE]]);

function candidate(over: Partial<{ file: string; line: number; snippet: string }> = {}) {
  return {
    evidence_path: over.file ?? FILE.path,
    evidence_line: over.line ?? 4,
    evidence_snippet: over.snippet ?? 'export const now = () =>',
  };
}

describe('groundCandidate — accepts real evidence', () => {
  it('matches an exact single line at the cited line', () => {
    expect(groundCandidate(candidate(), byPath).ok).toBe(true);
  });

  it('tolerates reflowed indentation and collapsed whitespace', () => {
    const res = groundCandidate(
      candidate({ line: 5, snippet: "timestamp('created_at',   { withTimezone: true }).defaultNow().notNull();" }),
      byPath,
    );
    expect(res.ok).toBe(true);
  });

  it('matches a multi-line snippet and reports the END line for the range', () => {
    const res = groundCandidate(
      candidate({
        line: 4,
        snippet:
          "export const now = () =>\n  timestamp('created_at', { withTimezone: true }).defaultNow().notNull();",
      }),
      byPath,
    );
    expect(res.ok).toBe(true);
    // Range end drives the `file:line-range` the UI renders.
    expect(res.endLine).toBe(5);
  });

  it('tolerates a small off-by-N in the cited line (within the window)', () => {
    // Snippet really lives on line 4; model cited 6.
    expect(groundCandidate(candidate({ line: 6 }), byPath).ok).toBe(true);
  });

  it('accepts a fragment quoted out of a longer line', () => {
    expect(groundCandidate(candidate({ line: 5, snippet: 'defaultNow().notNull()' }), byPath).ok).toBe(
      true,
    );
  });
});

describe('groundCandidate — rejects fabrications', () => {
  it('rejects a file that was never sampled', () => {
    const res = groundCandidate(candidate({ file: 'src/nope.ts' }), byPath);
    expect(res).toMatchObject({ ok: false, reason: 'unknown-file' });
  });

  it('rejects a line past the end of the file', () => {
    const res = groundCandidate(candidate({ line: 999 }), byPath);
    expect(res).toMatchObject({ ok: false, reason: 'line-out-of-range' });
  });

  it('rejects line 0 (1-indexed contract)', () => {
    expect(groundCandidate(candidate({ line: 0 }), byPath).ok).toBe(false);
  });

  it('rejects a snippet that appears nowhere near the cited line', () => {
    const res = groundCandidate(
      candidate({ line: 4, snippet: 'export const somethingInvented = true;' }),
      byPath,
    );
    expect(res).toMatchObject({ ok: false, reason: 'snippet-mismatch' });
  });

  it('rejects a snippet that exists but is FAR outside the window', () => {
    // 'OTHER' is on line 7; citing line 1 is too far to be a citation nit.
    const res = groundCandidate(candidate({ line: 1, snippet: 'export const OTHER = 1;' }), byPath);
    expect(res.ok).toBe(false);
  });

  it('rejects an empty snippet rather than trivially matching', () => {
    const res = groundCandidate(candidate({ snippet: '   \n  ' }), byPath);
    expect(res).toMatchObject({ ok: false, reason: 'empty-snippet' });
  });

  it('does not fold case — casing is itself a convention', () => {
    const res = groundCandidate(candidate({ snippet: 'EXPORT CONST NOW = () =>' }), byPath);
    expect(res.ok).toBe(false);
  });
});

describe('renderSamples', () => {
  it('prefixes 1-indexed line numbers so the model can cite them', () => {
    const out = renderSamples([FILE], 10_000);
    expect(out).toContain('--- FILE: src/db/schema/_shared.ts ---');
    expect(out).toContain("1: import { timestamp } from 'drizzle-orm/pg-core';");
    expect(out).toContain('4: export const now = () =>');
  });

  it('stops before exceeding the char budget instead of truncating mid-file', () => {
    const out = renderSamples([FILE, { path: 'b.ts', lines: ['x'] }], 60);
    expect(out).not.toContain('b.ts');
  });
});

describe('normalize / capLines', () => {
  it('collapses whitespace runs and trims', () => {
    expect(normalize('  a   b \t c  ')).toBe('a b c');
  });

  it('caps a file at the per-file line limit', () => {
    const many = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    expect(capLines(many).length).toBe(160);
  });
});
