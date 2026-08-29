/**
 * Smart-diff composition (`modules/smart-diff/helpers.ts`) — grouping, finding
 * attachment and the split suggestion. Pure functions of their arguments, so
 * they get unit coverage independent of the route's queries.
 */
import { describe, it, expect } from 'vitest';
import { SmartDiff } from '@devdigest/shared';
import { buildSmartDiff, buildSplitSuggestion, groupFiles } from '../src/modules/smart-diff/helpers.js';
import { LARGE_PR_LINES } from '../src/modules/smart-diff/constants.js';
import type { ChangedFileRow, FindingLineRow } from '../src/modules/smart-diff/repository.js';

const file = (path: string, additions = 5, deletions = 1): ChangedFileRow => ({
  path,
  additions,
  deletions,
});

const FILES: ChangedFileRow[] = [
  file('src/middleware/ratelimit.ts', 84, 0),
  file('src/api/public/webhooks.ts', 31, 6),
  file('src/api/public/index.ts', 12, 2),
  file('src/server.ts', 8, 1),
  file('package-lock.json', 92, 24),
];

describe('groupFiles', () => {
  it('emits all three groups in reading order, even when one is empty', () => {
    const groups = groupFiles([file('src/pay.ts')], []);
    expect(groups.map((g) => g.role)).toEqual(['core', 'wiring', 'boilerplate']);
    expect(groups[1]!.files).toEqual([]);
    expect(groups[2]!.files).toEqual([]);
  });

  it('sorts files into their classified role', () => {
    const groups = groupFiles(FILES, []);
    const paths = (role: string) =>
      groups.find((g) => g.role === role)!.files.map((f) => f.path);

    expect(paths('core')).toEqual(['src/middleware/ratelimit.ts', 'src/api/public/webhooks.ts']);
    expect(paths('wiring')).toEqual(['src/api/public/index.ts', 'src/server.ts']);
    expect(paths('boilerplate')).toEqual(['package-lock.json']);
  });

  it('carries additions/deletions through untouched', () => {
    const [core] = groupFiles(FILES, []);
    expect(core!.files[0]).toMatchObject({ additions: 84, deletions: 0 });
  });

  it('leaves pseudocode_summary null — that field is LLM output', () => {
    const [core] = groupFiles(FILES, []);
    expect(core!.files[0]!.pseudocode_summary).toBeNull();
  });
});

describe('groupFiles — finding lines', () => {
  const findings: FindingLineRow[] = [
    { file: 'src/api/public/webhooks.ts', startLine: 73, severity: 'CRITICAL' },
    { file: 'src/api/public/webhooks.ts', startLine: 61, severity: 'CRITICAL' },
    { file: 'src/api/public/webhooks.ts', startLine: 61, severity: 'WARNING' },
    { file: 'src/middleware/ratelimit.ts', startLine: 28, severity: 'SUGGESTION' },
  ];

  it('attaches deduped, ascending start lines to the matching file', () => {
    const [core] = groupFiles(FILES, findings);
    const byPath = new Map(core!.files.map((f) => [f.path, f.finding_lines]));
    expect(byPath.get('src/api/public/webhooks.ts')).toEqual([61, 73]);
    expect(byPath.get('src/middleware/ratelimit.ts')).toEqual([28]);
  });

  it('gives files with no findings an empty array, not undefined', () => {
    const groups = groupFiles(FILES, findings);
    const lockfile = groups.find((g) => g.role === 'boilerplate')!.files[0]!;
    expect(lockfile.finding_lines).toEqual([]);
  });

  it('returns the same groups with no review yet — just empty finding_lines', () => {
    const without = groupFiles(FILES, []);
    expect(without.flatMap((g) => g.files).every((f) => f.finding_lines.length === 0)).toBe(true);
    expect(without.map((g) => g.files.length)).toEqual(groupFiles(FILES, findings).map((g) => g.files.length));
  });

  it('ignores findings whose file is not in the diff', () => {
    const groups = groupFiles(FILES, [
      { file: 'src/deleted/gone.ts', startLine: 4, severity: 'WARNING' },
    ]);
    expect(groups.flatMap((g) => g.files).every((f) => f.finding_lines.length === 0)).toBe(true);
  });
});

describe('buildSplitSuggestion', () => {
  it('is not too_big under the threshold, and proposes nothing', () => {
    const small = [file('src/a.ts', 10, 5)];
    expect(buildSplitSuggestion(small, groupFiles(small, []))).toEqual({
      too_big: false,
      total_lines: 15,
      proposed_splits: [],
    });
  });

  it('counts total lines as additions + deletions across every file', () => {
    // 84 + 31+6 + 12+2 + 8+1 + 92+24 = 260
    expect(buildSplitSuggestion(FILES, groupFiles(FILES, [])).total_lines).toBe(260);
  });

  it('flags too_big past the threshold and splits core files by top-level dir', () => {
    const big: ChangedFileRow[] = [
      file('billing/charge.ts', LARGE_PR_LINES, 0),
      file('billing/refund.ts', 20, 0),
      file('search/query.ts', 30, 0),
      file('search/rank.ts', 10, 0),
      file('package-lock.json', 500, 0),
    ];
    const s = buildSplitSuggestion(big, groupFiles(big, []));
    expect(s.too_big).toBe(true);
    expect(s.proposed_splits).toEqual([
      { name: 'billing', files: ['billing/charge.ts', 'billing/refund.ts'] },
      { name: 'search', files: ['search/query.ts', 'search/rank.ts'] },
    ]);
  });

  it('never proposes splitting out boilerplate — only core is split', () => {
    const big: ChangedFileRow[] = [
      file('package-lock.json', 300, 0),
      file('pnpm-lock.yaml', 300, 0),
    ];
    const s = buildSplitSuggestion(big, groupFiles(big, []));
    expect(s.too_big).toBe(true);
    expect(s.proposed_splits).toEqual([]);
  });

  it('skips directories too small to be worth their own PR', () => {
    const big: ChangedFileRow[] = [
      file('billing/charge.ts', 300, 0),
      file('lonely/one.ts', 200, 0),
    ];
    expect(buildSplitSuggestion(big, groupFiles(big, [])).proposed_splits).toEqual([]);
  });
});

describe('buildSmartDiff', () => {
  it('produces a payload that satisfies the shared SmartDiff contract', () => {
    expect(() => SmartDiff.parse(buildSmartDiff(FILES, []))).not.toThrow();
  });

  it('satisfies the contract for a PR with no changed files at all', () => {
    const empty = SmartDiff.parse(buildSmartDiff([], []));
    expect(empty.groups.map((g) => g.role)).toEqual(['core', 'wiring', 'boilerplate']);
    expect(empty.split_suggestion).toEqual({ too_big: false, total_lines: 0, proposed_splits: [] });
  });
});
