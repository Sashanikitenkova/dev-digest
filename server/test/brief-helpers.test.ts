/* Pure helpers of the Why + Risk brief: the allowlist, the line index, the
   reference gate and the budget shedder. No container, no DB, no model.

   These cover the reference-integrity and token-budget halves of SPEC-02 —
   the two properties the feature's value rests on. A brief that names a file
   the repo does not contain costs exactly the attention it promised to save. */
import { describe, it, expect } from 'vitest';
import type { UnifiedDiff } from '@devdigest/shared';
import {
  buildAllowlist,
  buildValidLineIndex,
  validateItems,
  shedToBudget,
  protectedOnly,
  boundProtected,
  isFreshBrief,
} from '../src/modules/brief/helpers.js';
import { BRIEF_TOKEN_BUDGET } from '../src/modules/brief/constants.js';
import type { BriefParts } from '../src/modules/brief/prompt.js';

// ------------------------------------------------------------------ fixtures

function diffOf(
  files: { path: string; hunks: { newStart: number; newLines: number; newLineNumbers?: number[] }[] }[],
): UnifiedDiff {
  return {
    raw: 'THIS RAW DIFF MUST NEVER REACH A PROMPT',
    files: files.map((f) => ({
      path: f.path,
      additions: 1,
      deletions: 0,
      hunks: f.hunks.map((h) => ({
        oldStart: 1,
        oldLines: 1,
        newStart: h.newStart,
        newLines: h.newLines,
        newLineNumbers: h.newLineNumbers ?? [],
        lines: ['+const secret = "sk_live_LEAKED";'],
      })),
    })),
  } as unknown as UnifiedDiff;
}

const blast = {
  index: { status: 'full' as const },
  changed_symbols: [{ name: 'rateLimit', file: 'src/middleware/ratelimit.ts', line: 25 }],
  downstream: [
    {
      symbol: 'rateLimit',
      callers: [{ name: 'boot', file: 'src/server.ts', line: 88 }],
      caller_total: 1,
      endpoints_affected: [{ endpoint: 'GET /api/public/health', depth: 2 }],
      crons_affected: [],
    },
  ],
  impacted_endpoints: ['GET /api/public/items'],
  impacted_crons: [],
  summary: 'two symbols, one caller',
} as never;

function parts(over: Partial<BriefParts> = {}): BriefParts {
  return {
    title: 'Add rate limiting',
    author: 'marisa',
    branch: 'feat/rl',
    base: 'main',
    additions: 247,
    deletions: 38,
    filesCount: 2,
    changedFiles: ['src/middleware/ratelimit.ts', 'src/config.ts'],
    riskAreas: [{ severity: 'high', text: 'auth surface touched' }],
    intent: { intent: 'limit public endpoints', in_scope: ['middleware'], out_of_scope: ['auth'] },
    blastSummary: 'two symbols',
    blastSymbols: ['rateLimit'],
    blastEndpoints: ['GET /api/public/items'],
    contextPaths: ['docs/a.md', 'docs/b.md'],
    blastCallerFiles: ['src/server.ts'],
    diff: diffOf([{ path: 'src/middleware/ratelimit.ts', hunks: [{ newStart: 25, newLines: 4 }] }]),
    hunkHeaderFiles: 80,
    issue: { number: 42, title: 'Abuse from unauthenticated clients', body: 'ISSUE_BODY_TEXT' },
    body: 'PR_BODY_TEXT',
    notes: [],
    ...over,
  };
}

/** A tokenizer stand-in: 1 token per 4 chars, deterministic and injectable. */
const count = (t: string) => Math.ceil(t.length / 4);

// ------------------------------------------------------------- the allowlist

describe('buildAllowlist', () => {
  it('admits changed files, blast symbols, caller files and both endpoint sources', () => {
    const a = buildAllowlist({ changedFiles: ['src/config.ts'], blast });
    expect(a.files.has('src/config.ts')).toBe(true);
    expect(a.files.has('src/server.ts')).toBe(true); // caller file
    expect(a.symbols.has('rateLimit')).toBe(true);
    expect(a.endpoints.has('GET /api/public/items')).toBe(true); // top-level
    expect(a.endpoints.has('GET /api/public/health')).toBe(true); // downstream
  });

  it('yields no symbols and no endpoints when the index is missing (AC-34)', () => {
    const a = buildAllowlist({ changedFiles: ['src/config.ts'], blast: null });
    expect(a.symbols.size).toBe(0);
    expect(a.endpoints.size).toBe(0);
    expect(a.files.has('src/config.ts')).toBe(true);
  });
});

// ------------------------------------------------------------- the line index

describe('buildValidLineIndex', () => {
  it('uses newLineNumbers when the parser supplied them', () => {
    const idx = buildValidLineIndex(
      diffOf([{ path: 'a.ts', hunks: [{ newStart: 10, newLines: 3, newLineNumbers: [11, 13] }] }]),
    );
    expect([...idx.get('a.ts')!].sort((x, y) => x - y)).toEqual([11, 13]);
  });

  it('falls back to the declared new range when newLineNumbers is empty', () => {
    // The grounding gate's fallback (reviewer-core/src/grounding.ts:29-33).
    // Drop it and every diff parsed without per-line numbers grounds nothing.
    const idx = buildValidLineIndex(
      diffOf([{ path: 'a.ts', hunks: [{ newStart: 10, newLines: 3 }] }]),
    );
    expect([...idx.get('a.ts')!].sort((x, y) => x - y)).toEqual([10, 11, 12]);
  });

  it('treats newLines: 0 as covering at least one line', () => {
    const idx = buildValidLineIndex(
      diffOf([{ path: 'a.ts', hunks: [{ newStart: 7, newLines: 0 }] }]),
    );
    expect([...idx.get('a.ts')!]).toEqual([7]);
  });
});

// ------------------------------------------------------- the reference gate

describe('validateItems', () => {
  const allowlist = buildAllowlist({
    changedFiles: ['src/middleware/ratelimit.ts', 'src/config.ts'],
    blast,
  });
  const lineIndex = buildValidLineIndex(
    diffOf([
      { path: 'src/middleware/ratelimit.ts', hunks: [{ newStart: 25, newLines: 4 }] },
      { path: 'src/config.ts', hunks: [{ newStart: 12, newLines: 1 }] },
    ]),
  );
  const focus = (reference: unknown) => ({ summary: 's', reference }) as never;
  const run = (refs: unknown[]) =>
    validateItems({ risks: [], focus: refs.map(focus) }, allowlist, lineIndex);

  it('keeps a reference naming a real changed file at a real line', () => {
    expect(run([{ file: 'src/config.ts', line: 12 }]).focus).toHaveLength(1);
  });

  it('drops a file the allowlist does not contain (AC-25)', () => {
    // The model naming a plausible file the repo has no trace of is the whole
    // failure mode the gate exists for.
    expect(run([{ file: 'src/api/invented.ts' }]).focus).toHaveLength(0);
  });

  it('drops a real file at a line outside every hunk (AC-26)', () => {
    expect(run([{ file: 'src/config.ts', line: 9999 }]).focus).toHaveLength(0);
  });

  it('drops an invented symbol and an invented endpoint (AC-27)', () => {
    expect(run([{ symbol: 'neverDefined' }]).focus).toHaveLength(0);
    expect(run([{ endpoint: 'DELETE /api/nope' }]).focus).toHaveLength(0);
  });

  it('keeps a symbol-only and an endpoint-only reference', () => {
    expect(run([{ symbol: 'rateLimit' }]).focus).toHaveLength(1);
    expect(run([{ endpoint: 'GET /api/public/items' }]).focus).toHaveLength(1);
  });

  it('drops a line carried without a file (AC-20a)', () => {
    expect(run([{ line: 42 }]).focus).toHaveLength(0);
  });

  it('drops an empty reference and one whose only key is null or blank (AC-20)', () => {
    expect(run([{}]).focus).toHaveLength(0);
    expect(run([{ file: null }]).focus).toHaveLength(0);
    expect(run([{ file: '' }]).focus).toHaveLength(0);
    expect(run([{ file: '   ' }]).focus).toHaveLength(0);
  });

  it('never lets a valid field rescue an invalid one (AC-20b)', () => {
    // A real file plus an invented symbol: the summary was written ABOUT the
    // symbol, so keeping the row and silently dropping the pointer would be
    // worse than not showing it.
    expect(run([{ file: 'src/config.ts', symbol: 'neverDefined' }]).focus).toHaveLength(0);
    expect(run([{ file: 'src/api/invented.ts', symbol: 'rateLimit' }]).focus).toHaveLength(0);
  });

  it('compares paths by exact equality — no normalisation (AC-23)', () => {
    for (const variant of [
      'SRC/Config.ts',
      './src/config.ts',
      'src/../src/config.ts',
      'src//config.ts',
      'src\\config.ts',
    ]) {
      expect(run([{ file: variant }]).focus, variant).toHaveLength(0);
    }
  });

  it('reports proposed vs kept so an all-invented brief cannot look empty-but-fine (AC-28)', () => {
    const out = validateItems(
      {
        risks: [
          { severity: 'high', summary: 'a', reference: { file: 'src/config.ts', line: 12 } },
          { severity: 'low', summary: 'b', reference: { file: 'src/ghost.ts' } },
        ] as never,
        focus: [focus({ file: 'src/ghost.ts' })],
      },
      allowlist,
      lineIndex,
    );
    expect(out.counts).toEqual({
      risks_proposed: 2,
      risks_kept: 1,
      focus_proposed: 1,
      focus_kept: 0,
    });
  });

  it('returns empty arrays with populated counts when every item is invented (AC-32)', () => {
    const out = run([{ file: 'a' }, { file: 'b' }]);
    expect(out.focus).toEqual([]);
    expect(out.counts.focus_proposed).toBe(2);
    expect(out.counts.focus_kept).toBe(0);
  });
});

// ------------------------------------------------------------- the budget

describe('shedToBudget', () => {
  const overheadTokens = 1500; // realistic: system prompt + serialized schema

  it('returns the message untouched when it already fits', () => {
    const out = shedToBudget({ sections: parts(), overheadTokens, count });
    expect(out.ledger).toEqual([]);
    expect(out.text).toContain('PR_BODY_TEXT');
  });

  it('sheds in AC-14 order and stops as soon as it fits', () => {
    // A body big enough to force shedding, but not so big that everything goes.
    const big = parts({ body: 'x'.repeat(60_000) });
    const out = shedToBudget({ sections: big, overheadTokens, count });
    const order = out.ledger.map((e) => e.section);
    // context paths always go before the PR body
    expect(order.indexOf('context_paths')).toBeLessThan(order.indexOf('pr_body'));
    expect(out.ledger.every((e) => e.status === 'removed' && !!e.reason)).toBe(true);
    expect(overheadTokens + count(out.text)).toBeLessThanOrEqual(BRIEF_TOKEN_BUDGET);
  });

  it('never removes a protected section, even under extreme pressure (AC-14)', () => {
    const huge = parts({
      body: 'x'.repeat(200_000),
      issue: { number: 42, title: 't', body: 'y'.repeat(200_000) },
    });
    const out = shedToBudget({ sections: huge, overheadTokens, count });
    // The protected set survives verbatim.
    expect(out.text).toContain('Add rate limiting'); // title
    expect(out.text).toContain('marisa'); // author
    expect(out.text).toContain('feat/rl'); // branch
    expect(out.text).toContain('main'); // base
    expect(out.text).toContain('src/middleware/ratelimit.ts'); // changed file path
    expect(out.text).toContain('auth surface touched'); // risk scan
    expect(out.text).toContain('limit public endpoints'); // intent
    expect(out.text).toContain('GET /api/public/items'); // impacted endpoint
    // And the sheddable content is gone.
    expect(out.text).not.toContain('PR_BODY_TEXT');
  });

  it('is deterministic — identical inputs give a byte-identical prompt', () => {
    const a = shedToBudget({ sections: parts({ body: 'x'.repeat(60_000) }), overheadTokens, count });
    const b = shedToBudget({ sections: parts({ body: 'x'.repeat(60_000) }), overheadTokens, count });
    expect(a.text).toBe(b.text);
    expect(a.ledger).toEqual(b.ledger);
  });

  it('counts the fixed overhead, not just the user message', () => {
    // The defect the cross-model review found: with overhead ignored, a message
    // just under the budget passes while the real payload is over it.
    const near = parts({ body: 'x'.repeat(28_000) });
    const withOverhead = shedToBudget({ sections: near, overheadTokens: 1500, count });
    const withoutOverhead = shedToBudget({ sections: near, overheadTokens: 0, count });
    expect(count(withOverhead.text)).toBeLessThan(count(withoutOverhead.text));
    expect(1500 + count(withOverhead.text)).toBeLessThanOrEqual(BRIEF_TOKEN_BUDGET);
  });
});

describe('protectedOnly / boundProtected', () => {
  it('protectedOnly strips every sheddable section and keeps the protected ones', () => {
    const p = protectedOnly(parts());
    expect(p.title).toBe('Add rate limiting');
    expect(p.changedFiles).toEqual(['src/middleware/ratelimit.ts', 'src/config.ts']);
    expect(p.body).toBeNull();
    expect(p.contextPaths).toEqual([]);
    expect(p.blastCallerFiles).toEqual([]);
  });

  it('boundProtected bounds an oversized protected section and ledgers the reduction (AC-60/AC-62)', () => {
    const out = boundProtected(parts({ title: 'T'.repeat(5_000) }));
    expect(out.bounded.title.length).toBeLessThan(5_000);
    expect(out.ledger.length).toBeGreaterThan(0);
    // A bounded input stays `present` with a reason — it was reduced, not removed.
    expect(out.ledger.every((e) => e.status === 'present' && !!e.reason)).toBe(true);
  });
});

describe('isFreshBrief', () => {
  const row = (headSha: string | null) => ({ headSha }) as never;
  it('is fresh only when the stored head SHA equals the PR head', () => {
    expect(isFreshBrief(row('abc'), 'abc')).toBe(true);
    expect(isFreshBrief(row('abc'), 'def')).toBe(false);
  });
  it('treats a legacy row with a null head SHA as stale', () => {
    expect(isFreshBrief(row(null), 'abc')).toBe(false);
  });
  it('treats a missing row as stale', () => {
    expect(isFreshBrief(undefined, 'abc')).toBe(false);
  });
});
