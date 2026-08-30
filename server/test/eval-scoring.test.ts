import { describe, it, expect } from 'vitest';
import type { EvalExpectation } from '@devdigest/shared';
import {
  matchesTarget,
  scoreCase,
  aggregateBatch,
  type CaseCounters,
} from '../src/modules/eval/scoring.js';

/**
 * The deterministic core of the eval pipeline (SPEC-03).
 *
 * These tests are the evidence for the acceptance criterion "scoring makes no
 * LLM call": the module under test is imported directly, with no container, no
 * adapters and no network, and every case here is pure arithmetic over plain
 * objects. If this file ever needs a mock provider, the boundary has leaked.
 */

const f = (file: string, start: number, end = start) => ({
  file,
  start_line: start,
  end_line: end,
});

const mustFind = (...targets: { file: string; start_line: number; end_line: number }[]) =>
  ({ kind: 'must_find', targets }) as EvalExpectation;

const mustNotFlag = (...targets: { file: string; start_line: number; end_line: number }[]) =>
  ({ kind: 'must_not_flag', targets }) as EvalExpectation;

describe('matchesTarget', () => {
  it('matches when the file is equal and the line ranges overlap', () => {
    expect(matchesTarget(f('src/config.ts', 12), f('src/config.ts', 10, 14))).toBe(true);
  });

  it('matches on a single shared boundary line', () => {
    expect(matchesTarget(f('src/a.ts', 20, 30), f('src/a.ts', 30, 40))).toBe(true);
  });

  it('does not match a range that stops one line short', () => {
    expect(matchesTarget(f('src/a.ts', 10, 19), f('src/a.ts', 20, 25))).toBe(false);
  });

  it('does not match the same lines in a different file', () => {
    expect(matchesTarget(f('src/other.ts', 12), f('src/config.ts', 12))).toBe(false);
  });

  it('is insensitive to inverted line ranges on either side', () => {
    expect(matchesTarget(f('src/a.ts', 30, 20), f('src/a.ts', 25, 22))).toBe(true);
  });

  it('ignores severity, category and title — only geometry decides (AC-28)', () => {
    const target = {
      ...f('src/config.ts', 12),
      severity: 'CRITICAL',
      category: 'security',
      title: 'Hardcoded Stripe secret key',
    };
    // A finding with a completely different description still matches: matching
    // on prose would turn a prompt reword into a fake regression.
    expect(matchesTarget(f('src/config.ts', 12), target)).toBe(true);
  });
});

describe('scoreCase — must_find (an accepted finding)', () => {
  it('counts a hit as a true positive and passes', () => {
    const score = scoreCase(mustFind(f('src/config.ts', 12)), [f('src/config.ts', 12)], 0);
    expect(score).toMatchObject({ tp: 1, fp: 0, fn: 0, pass: true });
    expect(score.recall).toBe(1);
    expect(score.precision).toBe(1);
  });

  it('counts a near miss as a false negative AND a false positive, and fails', () => {
    // The agent commented on the same file but the wrong lines — it did not find
    // what was expected, and what it did say is noise.
    const score = scoreCase(mustFind(f('src/config.ts', 12)), [f('src/config.ts', 40, 44)], 0);
    expect(score).toMatchObject({ tp: 0, fp: 1, fn: 1, pass: false });
    expect(score.recall).toBe(0);
    expect(score.precision).toBe(0);
  });

  it('counts a hit in the wrong file as a miss', () => {
    const score = scoreCase(mustFind(f('src/config.ts', 12)), [f('src/other.ts', 12)], 0);
    expect(score).toMatchObject({ tp: 0, fp: 1, fn: 1, pass: false });
  });

  it('fails when only some of several targets are found', () => {
    const score = scoreCase(
      mustFind(f('src/a.ts', 10), f('src/a.ts', 50), f('src/b.ts', 3)),
      [f('src/a.ts', 10), f('src/b.ts', 3)],
      0,
    );
    expect(score).toMatchObject({ tp: 2, fn: 1, pass: false });
    expect(score.recall).toBeCloseTo(2 / 3);
  });

  it('does not let two findings on one target inflate recall', () => {
    // A target is claimed once; the second overlapping finding is noise.
    const score = scoreCase(
      mustFind(f('src/a.ts', 10, 20)),
      [f('src/a.ts', 11), f('src/a.ts', 12)],
      0,
    );
    expect(score).toMatchObject({ tp: 1, fp: 1, fn: 0, pass: true });
    expect(score.precision).toBe(0.5);
  });

  it('reports no findings at all as a clean miss with no precision evidence', () => {
    const score = scoreCase(mustFind(f('src/a.ts', 10)), [], 0);
    expect(score).toMatchObject({ tp: 0, fp: 0, fn: 1, pass: false });
    expect(score.recall).toBe(0);
    // 0/0 precision is an absence of evidence, not a zero score.
    expect(score.precision).toBeNull();
  });
});

describe('scoreCase — must_not_flag (a dismissed finding)', () => {
  it('passes when the agent stays quiet on the dismissed spot', () => {
    const score = scoreCase(mustNotFlag(f('src/util.ts', 7)), [], 0);
    expect(score).toMatchObject({ tp: 0, fp: 0, fn: 0, pass: true });
    // Nothing to recall — this case only ever contributes to precision.
    expect(score.recall).toBeNull();
  });

  it('counts a re-flag as a false positive and fails', () => {
    const score = scoreCase(mustNotFlag(f('src/util.ts', 7, 9)), [f('src/util.ts', 8)], 0);
    expect(score).toMatchObject({ tp: 0, fp: 1, fn: 0, pass: false });
    expect(score.precision).toBe(0);
  });

  it('ignores findings elsewhere in the same fragment', () => {
    // The author judged one spot, not the whole file.
    const score = scoreCase(mustNotFlag(f('src/util.ts', 7)), [f('src/util.ts', 90)], 0);
    expect(score).toMatchObject({ fp: 0, pass: true });
  });
});

describe('scoreCase — citation accuracy', () => {
  it('is the share of proposed findings that survived the grounding gate', () => {
    const score = scoreCase(mustFind(f('src/a.ts', 10)), [f('src/a.ts', 10)], 3);
    expect(score.kept).toBe(1);
    expect(score.dropped).toBe(3);
    expect(score.citationAccuracy).toBe(0.25);
  });

  it('is null, not 1, when the model proposed nothing', () => {
    expect(scoreCase(mustNotFlag(f('src/a.ts', 1)), [], 0).citationAccuracy).toBeNull();
  });
});

describe('aggregateBatch', () => {
  const c = (o: Partial<CaseCounters>): CaseCounters => ({
    tp: 0,
    fp: 0,
    fn: 0,
    kept: 0,
    dropped: 0,
    ...o,
  });

  it('sums counters rather than averaging per-case rates', () => {
    // Case A: 1 of 4 targets found. Case B: 1 of 1 found.
    // Summing gives 2/5 = 0.4. Averaging the rates would give (0.25+1)/2 = 0.625
    // — which would rise merely by adding small cases to the set.
    const m = aggregateBatch(
      [c({ tp: 1, fn: 3, kept: 1 }), c({ tp: 1, fn: 0, kept: 1 })],
      [false, true],
    );
    expect(m.recall).toBeCloseTo(0.4);
    expect(m.recall).not.toBeCloseTo(0.625);
  });

  it('lets a must_not_flag violation pull precision down while recall holds', () => {
    // This is the assignment's headline behaviour: a noisier prompt loses
    // precision on the dismissed cases without losing any recall.
    const clean = aggregateBatch([c({ tp: 2, kept: 2 }), c({ fp: 0, kept: 0 })], [true, true]);
    const noisy = aggregateBatch([c({ tp: 2, kept: 2 }), c({ fp: 2, kept: 2 })], [true, false]);
    expect(clean.precision).toBe(1);
    expect(noisy.precision).toBeCloseTo(0.5);
    expect(noisy.recall).toBe(clean.recall);
  });

  it('reports 1 for a metric with no denominator (AC-35)', () => {
    const m = aggregateBatch([c({ fp: 0, kept: 0, dropped: 0 })], [true]);
    expect(m.recall).toBe(1);
    expect(m.precision).toBe(1);
    expect(m.citationAccuracy).toBe(1);
  });

  it('counts passed and total traces', () => {
    const m = aggregateBatch([c({}), c({}), c({})], [true, false, true]);
    expect(m.tracesPassed).toBe(2);
    expect(m.tracesTotal).toBe(3);
  });

  it('re-derives a batch exactly from the persisted per-case counters (AC-36)', () => {
    // The counters are stored per case precisely so a batch row can be audited
    // later. Aggregating the stored rows must reproduce the original numbers.
    const cases = [
      scoreCase(mustFind(f('src/a.ts', 10), f('src/a.ts', 50)), [f('src/a.ts', 10)], 1),
      scoreCase(mustNotFlag(f('src/b.ts', 5)), [f('src/b.ts', 5)], 0),
      scoreCase(mustFind(f('src/c.ts', 1)), [f('src/c.ts', 1)], 0),
    ];
    const live = aggregateBatch(cases, cases.map((s) => s.pass));

    // Round-trip through what the DB would hold: the five integers only.
    const persisted = cases.map((s) =>
      c({ tp: s.tp, fp: s.fp, fn: s.fn, kept: s.kept, dropped: s.dropped }),
    );
    const rederived = aggregateBatch(persisted, cases.map((s) => s.pass));
    expect(rederived).toEqual(live);
    expect(live.recall).toBeCloseTo(2 / 3);
  });
});
