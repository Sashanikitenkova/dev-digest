import { describe, it, expect } from 'vitest';
import type { BlastResult } from '../src/modules/repo-intel/types.js';
import { toBlastRadius, toHistoryItems } from '../src/modules/blast/helpers.js';
import { MAX_CALLERS_PER_SYMBOL } from '../src/modules/blast/constants.js';

/**
 * Endpoint attribution is the property worth pinning here: the panel's whole
 * job is telling a reviewer what a change actually reaches, so a claim it can't
 * support must not be rendered. The degraded-path test is the important one.
 */

const RESULT: BlastResult = {
  changedSymbols: [
    { file: 'src/api/rateLimit.ts', name: 'rateLimit', kind: 'function' },
    { file: 'src/api/rateLimit.ts', name: 'bucketKey', kind: 'function' },
  ],
  callers: [
    { file: 'src/api/public/index.ts', symbol: 'handler', viaSymbol: 'rateLimit', line: 23, rank: 9 },
    { file: 'src/server.ts', symbol: 'boot', viaSymbol: 'rateLimit', line: 88, rank: 3 },
    { file: 'src/jobs/reset.ts', symbol: 'reset', viaSymbol: 'bucketKey', line: 12, rank: 1 },
  ],
  impactedEndpoints: ['GET /api/public/items', 'POST /api/public/webhooks'],
  factsByFile: {
    'src/api/public/index.ts': { endpoints: ['GET /api/public/items'], crons: [] },
    'src/server.ts': { endpoints: ['POST /api/public/webhooks'], crons: [] },
    'src/jobs/reset.ts': { endpoints: [], crons: ['reset-rate-buckets (hourly)'] },
  },
};

describe('toBlastRadius', () => {
  it('groups callers under the changed symbol they reach', () => {
    const blast = toBlastRadius(RESULT);
    const rateLimit = blast.downstream.find((d) => d.symbol === 'rateLimit')!;

    expect(blast.changed_symbols).toHaveLength(2);
    expect(rateLimit.callers.map((c) => c.file)).toEqual([
      'src/api/public/index.ts',
      'src/server.ts',
    ]);
    expect(rateLimit.callers[0]).toMatchObject({ name: 'handler', line: 23 });
  });

  it('attributes endpoints and crons via the caller file that declares them', () => {
    const blast = toBlastRadius(RESULT);
    const rateLimit = blast.downstream.find((d) => d.symbol === 'rateLimit')!;
    const bucketKey = blast.downstream.find((d) => d.symbol === 'bucketKey')!;

    expect(rateLimit.endpoints_affected).toEqual([
      'GET /api/public/items',
      'POST /api/public/webhooks',
    ]);
    expect(rateLimit.crons_affected).toEqual([]);
    // bucketKey's only caller lives in the cron file — it gets the cron, not the endpoints.
    expect(bucketKey.endpoints_affected).toEqual([]);
    expect(bucketKey.crons_affected).toEqual(['reset-rate-buckets (hourly)']);
  });

  it('orders callers by file rank, highest first', () => {
    const blast = toBlastRadius(RESULT);
    const ranks = blast.downstream.find((d) => d.symbol === 'rateLimit')!.callers;
    expect(ranks[0]!.file).toBe('src/api/public/index.ts');
  });

  it('caps the caller list per symbol', () => {
    const many: BlastResult = {
      ...RESULT,
      callers: Array.from({ length: MAX_CALLERS_PER_SYMBOL + 10 }, (_, i) => ({
        file: `src/c${i}.ts`,
        symbol: `c${i}`,
        viaSymbol: 'rateLimit',
        line: i + 1,
        rank: i,
      })),
    };
    const rateLimit = toBlastRadius(many).downstream.find((d) => d.symbol === 'rateLimit')!;
    expect(rateLimit.callers).toHaveLength(MAX_CALLERS_PER_SYMBOL);
    // The cap keeps the HIGHEST-ranked callers, not the first ones seen.
    expect(rateLimit.callers[0]!.name).toBe(`c${MAX_CALLERS_PER_SYMBOL + 9}`);
  });

  it('does not attribute endpoints to any symbol on the degraded path', () => {
    // No factsByFile → the index never said which symbol reaches which endpoint.
    const degraded: BlastResult = { ...RESULT, factsByFile: undefined, degraded: true };
    const blast = toBlastRadius(degraded);

    for (const d of blast.downstream) {
      expect(d.endpoints_affected).toEqual([]);
      expect(d.crons_affected).toEqual([]);
    }
    // …but the flat union is still reported, so nothing is silently lost.
    expect(blast.impacted_endpoints).toEqual([
      'GET /api/public/items',
      'POST /api/public/webhooks',
    ]);
    expect(blast.summary).toMatch(/partial index/);
  });

  it('reports an empty, well-formed radius for an unindexed repo', () => {
    const empty = toBlastRadius({ changedSymbols: [], callers: [], impactedEndpoints: [] });
    expect(empty.changed_symbols).toEqual([]);
    expect(empty.downstream).toEqual([]);
    expect(empty.impacted_endpoints).toEqual([]);
    expect(empty.summary).toBe('No indexed symbols changed in this PR.');
  });

  it('deduplicates the flat endpoint union', () => {
    const dupes: BlastResult = {
      ...RESULT,
      impactedEndpoints: ['GET /a', 'GET /a', 'GET /b'],
    };
    expect(toBlastRadius(dupes).impacted_endpoints).toEqual(['GET /a', 'GET /b']);
  });
});

describe('toHistoryItems', () => {
  it('maps prior PRs and sorts their overlapping paths', () => {
    const items = toHistoryItems([
      {
        number: 471,
        title: 'Add webhook signing',
        author: 'marisa.koch',
        updatedAt: new Date('2026-08-01T09:00:00.000Z'),
        overlap: ['src/server.ts', 'src/api/rateLimit.ts'],
      },
    ]);
    expect(items[0]).toEqual({
      pr_number: 471,
      title: 'Add webhook signing',
      merged_at: '2026-08-01T09:00:00.000Z',
      author: 'marisa.koch',
      files_overlap: ['src/api/rateLimit.ts', 'src/server.ts'],
      notes: '',
    });
  });

  it('renders a missing timestamp as empty rather than the epoch', () => {
    const items = toHistoryItems([
      { number: 12, title: 'Old PR', author: 'ana', updatedAt: null, overlap: [] },
    ]);
    expect(items[0]!.merged_at).toBe('');
  });
});
