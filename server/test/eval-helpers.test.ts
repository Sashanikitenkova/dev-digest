import { describe, it, expect } from 'vitest';
import type { EvalBatchRecord } from '@devdigest/shared';
import type { FindingRow } from '../src/db/rows.js';
import {
  expectationFromFinding,
  caseNameFromFinding,
  parseExpectation,
  metricDelta,
  skillsChanged,
  caseSetMismatch,
} from '../src/modules/eval/helpers.js';

const finding = (over: Partial<FindingRow> = {}): FindingRow =>
  ({
    id: 'f1',
    reviewId: 'r1',
    file: 'src/config.ts',
    startLine: 12,
    endLine: 12,
    severity: 'CRITICAL',
    category: 'security',
    title: 'Hardcoded Stripe secret key in commit',
    rationale: 'Line 12 contains a literal sk_live_ key.',
    suggestion: null,
    confidence: 0.98,
    kind: 'finding',
    trifectaComponents: null,
    acceptedAt: null,
    dismissedAt: null,
    outOfScope: false,
    scopeNote: null,
    ...over,
  }) as FindingRow;

const batch = (over: Partial<EvalBatchRecord> = {}): EvalBatchRecord =>
  ({
    id: 'b1',
    owner_kind: 'agent',
    owner_id: 'a1',
    status: 'done',
    started_at: '2026-08-30T10:00:00.000Z',
    finished_at: '2026-08-30T10:01:00.000Z',
    agent_version: 6,
    system_prompt: 'You are a security reviewer.',
    skills_snapshot: [],
    provider: 'openai',
    model: 'gpt-4.1',
    recall: 0.78,
    precision: 0.93,
    citation_accuracy: 0.94,
    traces_passed: 16,
    traces_total: 20,
    duration_ms: 1000,
    tokens_in: 100,
    tokens_out: 50,
    cost_usd: 0.21,
    error: null,
    ...over,
  }) as EvalBatchRecord;

describe('expectationFromFinding', () => {
  it('turns an accepted finding into must_find on its own file:line', () => {
    const e = expectationFromFinding(finding({ acceptedAt: new Date() }));
    expect(e.kind).toBe('must_find');
    expect(e.targets).toHaveLength(1);
    expect(e.targets[0]).toMatchObject({
      file: 'src/config.ts',
      start_line: 12,
      end_line: 12,
    });
  });

  it('turns a dismissed finding into must_not_flag', () => {
    const e = expectationFromFinding(finding({ dismissedAt: new Date() }));
    expect(e.kind).toBe('must_not_flag');
  });

  it('refuses a finding with no decision — an unreviewed finding is not a label', () => {
    expect(() => expectationFromFinding(finding())).toThrow(/Accept or dismiss/i);
  });

  it('carries severity/category/title through for display only', () => {
    const e = expectationFromFinding(finding({ acceptedAt: new Date() }));
    expect(e.targets[0]).toMatchObject({ severity: 'CRITICAL', category: 'security' });
  });
});

describe('caseNameFromFinding', () => {
  it('slugs the title down to a short stable name', () => {
    expect(caseNameFromFinding(finding())).toBe('hardcoded-stripe-secret-key-in');
  });

  it('falls back to file:line when the title has no usable characters', () => {
    expect(caseNameFromFinding(finding({ title: '!!!' }))).toBe('finding-config.ts:12');
  });
});

describe('parseExpectation', () => {
  it('accepts a well-formed expectation', () => {
    const raw = { kind: 'must_find', targets: [{ file: 'a.ts', start_line: 1, end_line: 2 }] };
    expect(parseExpectation(raw, 'c').kind).toBe('must_find');
  });

  it('rejects an expectation with no targets rather than scoring it as a miss', () => {
    expect(() => parseExpectation({ kind: 'must_find', targets: [] }, 'stripe-key')).toThrow(
      /stripe-key/,
    );
  });

  it('rejects an unknown expectation kind', () => {
    expect(() => parseExpectation({ kind: 'maybe', targets: [] }, 'c')).toThrow();
  });
});

describe('metricDelta', () => {
  it('reports b minus a per metric', () => {
    const d = metricDelta(batch({ recall: 0.78 }), batch({ recall: 0.82 }));
    expect(d.recall).toBeCloseTo(0.04);
  });

  it('reports null where either side has no value', () => {
    expect(metricDelta(batch({ cost_usd: null }), batch()).cost_usd).toBeNull();
  });
});

describe('skillsChanged', () => {
  it('is false for the same skills at the same versions, in any order', () => {
    const a = batch({
      skills_snapshot: [
        { skill_id: 's1', version: 3 },
        { skill_id: 's2', version: 1 },
      ],
    });
    const b = batch({
      skills_snapshot: [
        { skill_id: 's2', version: 1 },
        { skill_id: 's1', version: 3 },
      ],
    });
    expect(skillsChanged(a, b)).toBe(false);
  });

  it('is true when a linked skill body was edited — same id, new version', () => {
    // The link is unchanged, so comparing ids alone would miss this entirely.
    const a = batch({ skills_snapshot: [{ skill_id: 's1', version: 3 }] });
    const b = batch({ skills_snapshot: [{ skill_id: 's1', version: 4 }] });
    expect(skillsChanged(a, b)).toBe(true);
  });

  it('is true when a skill was unlinked', () => {
    const a = batch({ skills_snapshot: [{ skill_id: 's1', version: 3 }] });
    expect(skillsChanged(a, batch({ skills_snapshot: [] }))).toBe(true);
  });
});

describe('caseSetMismatch', () => {
  it('is false for the same ids in a different order', () => {
    expect(caseSetMismatch(['a', 'b'], ['b', 'a'])).toBe(false);
  });

  it('is true when a case was added between the two runs', () => {
    expect(caseSetMismatch(['a', 'b'], ['a', 'b', 'c'])).toBe(true);
  });
});
