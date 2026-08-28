/**
 * Project-context module (SPEC-01) — pure helpers. No DB, no I/O: exercises
 * `documentType`, `mergeAttachments` and `safeContextPath` directly, the way
 * `intent-helpers.test.ts` covers `safeRepoRelativePath`.
 */
import { describe, it, expect } from 'vitest';
import {
  contextTokens,
  documentType,
  mergeAttachments,
  safeContextPath,
} from '../src/modules/context/helpers.js';

const ROOTS = ['specs', 'docs', 'insights'];

describe('documentType', () => {
  // AC-3: exactly ONE type, drawn from the FIRST path segment.
  it('returns the configured root the path is found under', () => {
    expect(documentType('specs/api.md', ROOTS)).toBe('specs');
    expect(documentType('docs/architecture.md', ROOTS)).toBe('docs');
    expect(documentType('insights/lessons.md', ROOTS)).toBe('insights');
  });

  // A path can only ever match its FIRST segment — a `docs/specs/x.md`
  // document is a `docs` document, never both, so per-type totals never
  // double-count it.
  it('a nested root-lookalike segment does not change the type — the FIRST segment wins', () => {
    expect(documentType('docs/specs/x.md', ROOTS)).toBe('docs');
    expect(documentType('specs/docs/y.md', ROOTS)).toBe('specs');
  });

  it('returns null for a path under no configured root', () => {
    expect(documentType('src/notes.md', ROOTS)).toBeNull();
    expect(documentType('README.md', ROOTS)).toBeNull();
  });

  it('returns null for an empty path', () => {
    expect(documentType('', ROOTS)).toBeNull();
  });
});

describe('mergeAttachments', () => {
  // AC-12: agent's own attachments first, then each skill group in order.
  it('places the agent’s own attachments before every skill group', () => {
    const merged = mergeAttachments(
      ['docs/agent-own.md'],
      [{ skillId: 's1', paths: ['docs/skill-a.md'] }],
    );
    expect(merged).toEqual(['docs/agent-own.md', 'docs/skill-a.md']);
  });

  it('preserves each skill group’s own order, and the groups’ own order as given', () => {
    const merged = mergeAttachments(
      [],
      [
        { skillId: 's1', paths: ['docs/a.md', 'docs/b.md'] },
        { skillId: 's2', paths: ['docs/c.md'] },
      ],
    );
    expect(merged).toEqual(['docs/a.md', 'docs/b.md', 'docs/c.md']);
  });

  // AC-13 / EC-5: a duplicate path across attachment sets is emitted ONCE, at
  // its EARLIEST position.
  it('dedupes a path shared across sets, keeping the EARLIEST position', () => {
    const merged = mergeAttachments(
      ['docs/shared.md'],
      [{ skillId: 's1', paths: ['docs/shared.md', 'docs/only-skill.md'] }],
    );
    expect(merged).toEqual(['docs/shared.md', 'docs/only-skill.md']);
  });

  it('dedupes a path shared between two skills, keeping the position of the FIRST skill group', () => {
    const merged = mergeAttachments(
      [],
      [
        { skillId: 's1', paths: ['docs/shared.md'] },
        { skillId: 's2', paths: ['docs/shared.md', 'docs/second-only.md'] },
      ],
    );
    expect(merged).toEqual(['docs/shared.md', 'docs/second-only.md']);
  });

  it('returns [] for no agent attachments and no skill groups', () => {
    expect(mergeAttachments([], [])).toEqual([]);
  });
});

describe('safeContextPath', () => {
  it('accepts a plain repo-relative .md path', () => {
    expect(safeContextPath('docs/architecture.md')).toBe('docs/architecture.md');
  });

  // EC-11 / AC-10: traversal, absolute paths, backslashes and null bytes are
  // all rejected by the delegated safeRepoRelativePath gate.
  it('rejects a path containing ..', () => {
    expect(safeContextPath('docs/../../etc/passwd.md')).toBeNull();
    expect(safeContextPath('../secrets.md')).toBeNull();
  });

  it('rejects an absolute path', () => {
    expect(safeContextPath('/etc/passwd.md')).toBeNull();
  });

  it('rejects a path containing a backslash', () => {
    expect(safeContextPath('docs\\architecture.md')).toBeNull();
  });

  it('rejects a path containing a null byte', () => {
    expect(safeContextPath('docs/architecture.md\0.md')).toBeNull();
  });

  // AC-10 / EC-11: this feature narrows the allowlist to `.md` alone —
  // extensions the intent module's SPEC_EXTENSIONS would otherwise admit
  // (.txt, .mdx) must still be rejected HERE.
  it('rejects a .txt extension even though the intent module would admit it', () => {
    expect(safeContextPath('docs/notes.txt')).toBeNull();
  });

  it('rejects a .mdx extension', () => {
    expect(safeContextPath('docs/architecture.mdx')).toBeNull();
  });

  it('rejects a path with no extension at all', () => {
    expect(safeContextPath('docs/README')).toBeNull();
  });
});

describe('contextTokens', () => {
  // Non-functional requirements: token counts are ceil(characters / 4).
  it('computes ceil(chars / 4)', () => {
    expect(contextTokens('')).toBe(0);
    expect(contextTokens('a')).toBe(1); // ceil(1/4) = 1
    expect(contextTokens('abcd')).toBe(1); // ceil(4/4) = 1
    expect(contextTokens('abcde')).toBe(2); // ceil(5/4) = 2
    expect(contextTokens('x'.repeat(400))).toBe(100);
  });
});
