import { describe, it, expect } from 'vitest';
import type { IntentSource } from '@devdigest/shared';
import { parseUnifiedDiff } from '../src/adapters/git/diff-parser.js';
import {
  computeConfidence,
  confidenceLevel,
  describeSources,
  extractIssueNumber,
  extractSpecPaths,
  extractUrls,
  isFresh,
  renderHunkHeaders,
  safeRepoRelativePath,
} from '../src/modules/intent/helpers.js';

/**
 * Pure-helper tests for the intent classifier.
 *
 * Two of these are security boundaries rather than behaviour checks:
 * `renderHunkHeaders` is why no diff BODY can reach the cheap model, and
 * `safeRepoRelativePath` is the containment check `GitClient.readFile` lacks.
 * They are asserted as properties, not examples.
 */

const DIFF = parseUnifiedDiff(
  `diff --git a/src/config.ts b/src/config.ts
--- a/src/config.ts
+++ b/src/config.ts
@@ -10,3 +10,4 @@
   port: 3000,
+  stripeKey: "sk_live_xxx",
   redisUrl: x,
diff --git a/src/server.ts b/src/server.ts
--- a/src/server.ts
+++ b/src/server.ts
@@ -88,2 +88,3 @@
   app.listen();
+  app.use(rateLimit());
`,
);

const source = (
  kind: IntentSource['kind'],
  status: IntentSource['status'],
  reason: string | null = null,
): IntentSource => ({ kind, ref: null, status, reason });

describe('renderHunkHeaders — no diff bodies reach the classifier', () => {
  it('emits file names and @@ headers', () => {
    const out = renderHunkHeaders(DIFF);
    expect(out).toContain('src/config.ts (1 added, 0 removed)');
    expect(out).toContain('@@ -10,3 +10,4 @@');
    expect(out).toContain('src/server.ts (1 added, 0 removed)');
    expect(out).toContain('@@ -88,2 +88,3 @@');
  });

  it('leaks no added/removed source line from the diff', () => {
    const out = renderHunkHeaders(DIFF);
    // The literal secret is the canary: it exists in DIFF.raw and must not survive.
    expect(out).not.toContain('sk_live_xxx');
    expect(out).not.toContain('stripeKey');
    expect(out).not.toContain('rateLimit()');
    expect(out).not.toContain('port: 3000');
  });

  it('produces no line carrying a diff marker except the @@ headers', () => {
    for (const line of renderHunkHeaders(DIFF).split('\n')) {
      const body = line.trim();
      if (body.startsWith('@@')) continue;
      expect(body.startsWith('+')).toBe(false);
      expect(body.startsWith('-')).toBe(false);
    }
  });

  it('caps the file list and says how many it hid', () => {
    const many = parseUnifiedDiff(
      Array.from({ length: 5 }, (_, i) =>
        `diff --git a/f${i}.ts b/f${i}.ts\n--- a/f${i}.ts\n+++ b/f${i}.ts\n@@ -1,1 +1,2 @@\n+x`,
      ).join('\n'),
    );
    const out = renderHunkHeaders(many, 2);
    expect(out).toContain('(3 further changed file(s) omitted)');
  });
});

describe('safeRepoRelativePath — the containment gate', () => {
  it('accepts a plain repo-relative doc path', () => {
    expect(safeRepoRelativePath('docs/plan.md')).toBe('docs/plan.md');
    expect(safeRepoRelativePath('./docs/plan.md')).toBe('docs/plan.md');
    expect(safeRepoRelativePath('spec/api.rst')).toBe('spec/api.rst');
  });

  it.each([
    ['parent traversal', '../../etc/passwd'],
    ['embedded traversal', 'docs/../../../etc/passwd.md'],
    ['single dot segment', 'docs/./plan.md'],
    ['absolute', '/etc/passwd'],
    ['home-relative', '~/secrets.md'],
    ['backslash', 'docs\\..\\..\\plan.md'],
    ['null byte', 'docs/plan.md\0.txt'],
    ['url-encoded traversal', 'docs/%2e%2e/%2e%2e/plan.md'],
    ['scheme', 'file:///etc/passwd.md'],
    ['double slash', 'docs//plan.md'],
    ['trailing slash', 'docs/plan.md/'],
    ['too deep', 'a/b/c/d/e/f/g/plan.md'],
    ['wrong extension', 'src/config.ts'],
    ['no extension', 'docs/plan'],
    ['empty', ''],
  ])('rejects %s', (_label, input) => {
    expect(safeRepoRelativePath(input)).toBeNull();
  });

  it('rejects an over-long path', () => {
    expect(safeRepoRelativePath(`docs/${'a'.repeat(300)}.md`)).toBeNull();
  });
});

describe('extractSpecPaths / extractUrls / extractIssueNumber', () => {
  it('finds doc paths mentioned in a body', () => {
    const paths = extractSpecPaths('Implements the plan in docs/plan.md and (spec/api.rst).');
    expect(paths).toContain('docs/plan.md');
    expect(paths).toContain('spec/api.rst');
  });

  it('does not turn a URL into a repo path', () => {
    // The gate would reject it anyway; not producing the candidate at all keeps
    // the source ledger honest — it is a `url`, not a failed `spec_file`.
    const paths = extractSpecPaths('See https://example.com/docs/plan.md for details.');
    expect(paths).not.toContain('docs/plan.md');
  });

  it('collects external links without fetching them', () => {
    expect(extractUrls('Plan: https://notion.so/abc and https://linear.app/x.')).toEqual([
      'https://notion.so/abc',
      'https://linear.app/x',
    ]);
  });

  it('reads a linked issue number', () => {
    expect(extractIssueNumber('Add rate limiting. Closes #471.')).toBe(471);
    expect(extractIssueNumber('no issue here')).toBeNull();
  });
});

describe('computeConfidence — deterministic ceiling, model can only lower it', () => {
  const body = source('body', 'used');
  const issue = source('linked_issue', 'used');

  it('no usable body → low', () => {
    const { confidence, level } = computeConfidence(
      [source('title', 'used'), source('body', 'missing', 'empty_body')],
      1,
    );
    expect(level).toBe('low');
    expect(confidence).toBeLessThan(0.5);
  });

  it('body only → medium', () => {
    expect(computeConfidence([source('title', 'used'), body], 1).level).toBe('medium');
  });

  it('body + linked issue → high', () => {
    expect(computeConfidence([source('title', 'used'), body, issue], 1).level).toBe('high');
  });

  it('body + spec file → high', () => {
    expect(
      computeConfidence([source('title', 'used'), body, source('spec_file', 'used')], 1).level,
    ).toBe('high');
  });

  it('an overconfident model cannot exceed the ceiling', () => {
    // The whole point: self-reported confidence is poorly calibrated, so it is
    // an input to a min(), never the answer.
    expect(computeConfidence([source('title', 'used'), body], 0.99).confidence).toBe(0.7);
  });

  it('an underconfident model does lower the result', () => {
    const { confidence, level } = computeConfidence([source('title', 'used'), body, issue], 0.2);
    expect(confidence).toBe(0.2);
    expect(level).toBe('low');
  });

  it('a missing non-url source caps the ceiling at medium', () => {
    const { level } = computeConfidence(
      [source('title', 'used'), body, issue, source('spec_file', 'missing', 'not_in_clone')],
      1,
    );
    expect(level).toBe('medium');
  });

  it('a missing url does NOT cap it — urls are missing by design', () => {
    const { level } = computeConfidence(
      [source('title', 'used'), body, issue, source('url', 'missing', 'external_fetch_disabled')],
      1,
    );
    expect(level).toBe('high');
  });

  it('buckets at the documented boundaries', () => {
    expect(confidenceLevel(0.49)).toBe('low');
    expect(confidenceLevel(0.5)).toBe('medium');
    expect(confidenceLevel(0.84)).toBe('medium');
    expect(confidenceLevel(0.85)).toBe('high');
  });
});

describe('describeSources — log line carries kinds and refs only', () => {
  it('names used and missing sources with reasons', () => {
    const line = describeSources([
      { kind: 'title', ref: null, status: 'used', reason: null },
      { kind: 'linked_issue', ref: '#42', status: 'used', reason: null },
      {
        kind: 'url',
        ref: 'https://notion.so/secret-doc',
        status: 'missing',
        reason: 'external_fetch_disabled',
      },
    ]);
    expect(line).toContain('sources used: title, linked_issue:#42');
    expect(line).toContain('external_fetch_disabled');
  });
});

describe('isFresh', () => {
  const row = (headSha: string | null) =>
    ({ headSha }) as unknown as Parameters<typeof isFresh>[0];

  it('matches on head sha', () => {
    expect(isFresh(row('abc123'), 'abc123')).toBe(true);
    expect(isFresh(row('abc123'), 'def456')).toBe(false);
  });

  it('treats a pre-migration row (null head_sha) as stale', () => {
    expect(isFresh(row(null), 'abc123')).toBe(false);
    expect(isFresh(undefined, 'abc123')).toBe(false);
  });
});
