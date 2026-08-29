import { describe, it, expect } from 'vitest';
import type { BlastResult, IndexState } from '../src/modules/repo-intel/types.js';
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
      { endpoint: 'GET /api/public/items', depth: 1 },
      { endpoint: 'POST /api/public/webhooks', depth: 1 },
    ]);
    expect(rateLimit.crons_affected).toEqual([]);
    // bucketKey's only caller lives in the cron file — it gets the cron, not the endpoints.
    expect(bucketKey.endpoints_affected).toEqual([]);
    expect(bucketKey.crons_affected).toEqual([
      { endpoint: 'reset-rate-buckets (hourly)', depth: 1 },
    ]);
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

describe('toBlastRadius — reverse-graph attribution', () => {
  /**
   * `mid.ts` never names `rateLimit`, so it is not a caller — it merely imports
   * the file that declares it. Its endpoint is still impacted, and only the
   * reverse walk can say so.
   */
  const REACHED: BlastResult = {
    ...RESULT,
    callers: [],
    reachedFiles: {
      'src/api/mid.ts': { fromFile: 'src/api/rateLimit.ts', depth: 1 },
    },
    factsByFile: {
      'src/api/mid.ts': { endpoints: ['GET /api/public/health'], crons: ['nightly'] },
    },
  };

  it('attributes an endpoint from a file that imports the changed file without calling it', () => {
    const blast = toBlastRadius(REACHED);
    const rateLimit = blast.downstream.find((d) => d.symbol === 'rateLimit')!;
    // Depth 1 here: `mid.ts` imports the changed file directly.
    expect(rateLimit.endpoints_affected).toEqual([
      { endpoint: 'GET /api/public/health', depth: 1 },
    ]);
    expect(rateLimit.crons_affected).toEqual([{ endpoint: 'nightly', depth: 1 }]);
  });

  it('carries the hop distance of the file the endpoint was found in', () => {
    const blast = toBlastRadius({
      ...RESULT,
      callers: [],
      reachedFiles: {
        'src/near.ts': { fromFile: 'src/api/rateLimit.ts', depth: 1 },
        'src/far.ts': { fromFile: 'src/api/rateLimit.ts', depth: 2 },
      },
      factsByFile: {
        'src/near.ts': { endpoints: ['GET /near'], crons: [] },
        'src/far.ts': { endpoints: ['GET /far'], crons: [] },
      },
    });
    // Nearest first: a 2-hop claim is true but nearly content-free through a
    // barrel file, so the reader needs to see which is which.
    expect(blast.downstream.find((d) => d.symbol === 'rateLimit')!.endpoints_affected).toEqual([
      { endpoint: 'GET /near', depth: 1 },
      { endpoint: 'GET /far', depth: 2 },
    ]);
  });

  it('keeps the SHALLOWEST evidence when an endpoint is reachable two ways', () => {
    const blast = toBlastRadius({
      ...RESULT,
      callers: [
        { file: 'src/dual.ts', symbol: 'h', viaSymbol: 'rateLimit', line: 1, rank: 1 },
      ],
      reachedFiles: { 'src/dual.ts': { fromFile: 'src/api/rateLimit.ts', depth: 2 } },
      factsByFile: { 'src/dual.ts': { endpoints: ['GET /dual'], crons: [] } },
    });
    // Calling the symbol is direct evidence; the weaker 2-hop path must not
    // downgrade it.
    expect(blast.downstream.find((d) => d.symbol === 'rateLimit')!.endpoints_affected).toEqual([
      { endpoint: 'GET /dual', depth: 1 },
    ]);
  });

  it('only attributes to symbols declared in the file that was actually depended on', () => {
    const blast = toBlastRadius({
      ...REACHED,
      changedSymbols: [
        { file: 'src/api/rateLimit.ts', name: 'rateLimit', kind: 'function' },
        { file: 'src/api/untouched.ts', name: 'elsewhere', kind: 'function' },
      ],
    });
    const elsewhere = blast.downstream.find((d) => d.symbol === 'elsewhere')!;
    expect(elsewhere.endpoints_affected).toEqual([]);
  });

  it('unions caller evidence and reverse-graph evidence without duplicating', () => {
    const blast = toBlastRadius({
      ...RESULT,
      reachedFiles: { 'src/server.ts': { fromFile: 'src/api/rateLimit.ts', depth: 1 } },
    });
    const rateLimit = blast.downstream.find((d) => d.symbol === 'rateLimit')!;
    // 'POST /api/public/webhooks' is reachable BOTH ways; it must appear once.
    expect(rateLimit.endpoints_affected).toEqual([
      { endpoint: 'GET /api/public/items', depth: 1 },
      { endpoint: 'POST /api/public/webhooks', depth: 1 },
    ]);
  });

  it('attributes nothing extra when the graph is absent (partial index)', () => {
    const blast = toBlastRadius({ ...RESULT, reachedFiles: undefined });
    const rateLimit = blast.downstream.find((d) => d.symbol === 'rateLimit')!;
    expect(rateLimit.endpoints_affected).toEqual([
      { endpoint: 'GET /api/public/items', depth: 1 },
      { endpoint: 'POST /api/public/webhooks', depth: 1 },
    ]);
  });
});

describe('toBlastRadius — caller_total', () => {
  it('reports the pre-truncation count from the facade', () => {
    const blast = toBlastRadius({ ...RESULT, callerTotals: { rateLimit: 43, bucketKey: 1 } });
    const rateLimit = blast.downstream.find((d) => d.symbol === 'rateLimit')!;
    expect(rateLimit.callers).toHaveLength(2);
    expect(rateLimit.caller_total).toBe(43);
  });

  it('falls back to the listed count when the facade did not supply one', () => {
    const blast = toBlastRadius(RESULT);
    expect(blast.downstream.find((d) => d.symbol === 'rateLimit')!.caller_total).toBe(2);
  });
});

describe('toBlastRadius — index state', () => {
  const state = (over: Partial<IndexState>): IndexState => ({
    repoId: 'r1',
    status: 'full',
    filesIndexed: 120,
    filesSkipped: 0,
    durationMs: 10,
    lastIndexedSha: 'abc123',
    indexerVersion: 2,
    updatedAt: new Date('2026-08-18T09:00:00.000Z'),
    ...over,
  });

  it('passes a full index through', () => {
    const info = toBlastRadius(RESULT, state({})).index;
    expect(info.status).toBe('full');
    expect(info.files_indexed).toBe(120);
    expect(info.last_indexed_sha).toBe('abc123');
    expect(info.updated_at).toBe('2026-08-18T09:00:00.000Z');
  });

  it('keeps partial distinct from failed — a partial index still has real results', () => {
    expect(toBlastRadius(RESULT, state({ status: 'partial', reason: 'soft_budget' })).index)
      .toMatchObject({ status: 'partial', reason: 'soft_budget' });
  });

  it('reports a never-indexed repo as missing, not as failed', () => {
    const info = toBlastRadius(RESULT, state({ status: 'degraded', lastIndexedSha: '' })).index;
    expect(info.status).toBe('missing');
  });

  it('reports a degraded index that HAS been indexed as failed', () => {
    const info = toBlastRadius(RESULT, state({ status: 'degraded' })).index;
    expect(info.status).toBe('failed');
  });

  it('defaults to missing when no state is supplied at all', () => {
    expect(toBlastRadius(RESULT).index.status).toBe('missing');
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
