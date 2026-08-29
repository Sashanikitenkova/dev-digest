import { describe, expect, it } from 'vitest';
import type { ApiAgent } from '../src/ports.js';
import {
  DEFAULT_MAX_CONVENTIONS,
  DEFAULT_MAX_FINDINGS,
  shapeAgents,
  shapeConventions,
  shapeFindings,
  shapeReview,
  shapeReviewList,
} from '../src/shape.js';
import { agent, convention, finding, review } from './stub-api.js';

/** DOMAIN ring — pure mappers. No stub port needed; these touch nothing. */

describe('shapeAgents', () => {
  it('returns name (not id) plus description, model and enabled', () => {
    expect(shapeAgents([agent()])).toEqual([
      {
        name: 'Security Reviewer',
        description: 'Finds security issues.',
        model: 'anthropic/claude-sonnet-4',
        enabled: true,
      },
    ]);
  });

  it('drops every field the model cannot act on, including system_prompt', () => {
    // Cast: the narrow port schema has no `system_prompt`, but the real API
    // payload does, and shaping must not leak it even if it arrives.
    const withPrompt = {
      ...agent(),
      system_prompt: 'a very long seeded prompt'.repeat(200),
      version: 3,
      strategy: 'single-pass',
      skills_count: 4,
    } as ApiAgent;

    const shaped = shapeAgents([withPrompt]);

    expect(Object.keys(shaped[0]!)).toEqual(['name', 'description', 'model', 'enabled']);
    expect(JSON.stringify(shaped)).not.toContain('system_prompt');
    expect(JSON.stringify(shaped)).not.toContain('seeded prompt');
  });

  it('keeps disabled agents, flagged — running one explicitly by id is legal', () => {
    const shaped = shapeAgents([agent({ name: 'Off', enabled: false })]);
    expect(shaped).toHaveLength(1);
    expect(shaped[0]!.enabled).toBe(false);
  });
});

describe('shapeFindings', () => {
  it('omits rationale and confidence by default', () => {
    const shaped = shapeFindings([finding()]);
    expect(shaped[0]).not.toHaveProperty('rationale');
    expect(shaped[0]).not.toHaveProperty('confidence');
    expect(Object.keys(shaped[0]!)).toEqual([
      'severity',
      'category',
      'title',
      'file',
      'start_line',
      'end_line',
    ]);
  });

  it('includes rationale and confidence under detail', () => {
    const shaped = shapeFindings([finding()], { detail: true });
    expect(shaped[0]!.rationale).toContain('long markdown rationale');
    expect(shaped[0]!.confidence).toBe(0.8);
  });

  it('includes suggestion only when the API supplied one', () => {
    expect(shapeFindings([finding({ suggestion: null })])[0]).not.toHaveProperty('suggestion');
    expect(shapeFindings([finding({ suggestion: 'Add a guard.' })])[0]!.suggestion).toBe(
      'Add a guard.',
    );
  });

  it('orders most severe first', () => {
    const shaped = shapeFindings([
      finding({ severity: 'SUGGESTION', title: 's' }),
      finding({ severity: 'CRITICAL', title: 'c' }),
      finding({ severity: 'WARNING', title: 'w' }),
    ]);
    expect(shaped.map((f) => f.title)).toEqual(['c', 'w', 's']);
  });

  it('is stable within a severity, preserving API order', () => {
    const shaped = shapeFindings([
      finding({ severity: 'WARNING', title: 'first' }),
      finding({ severity: 'WARNING', title: 'second' }),
    ]);
    expect(shaped.map((f) => f.title)).toEqual(['first', 'second']);
  });

  it('truncates to max, keeping the most severe', () => {
    const shaped = shapeFindings(
      [
        finding({ severity: 'SUGGESTION', title: 's' }),
        finding({ severity: 'CRITICAL', title: 'c' }),
      ],
      { max: 1 },
    );
    expect(shaped.map((f) => f.title)).toEqual(['c']);
  });

  it('defaults max to 20, matching the verbatim tool description', () => {
    const many = Array.from({ length: 50 }, (_, i) => finding({ title: `f${i}` }));
    expect(shapeFindings(many)).toHaveLength(DEFAULT_MAX_FINDINGS);
    expect(DEFAULT_MAX_FINDINGS).toBe(20);
  });

  it('treats a negative max as zero rather than slicing from the end', () => {
    expect(shapeFindings([finding()], { max: -3 })).toEqual([]);
  });
});

describe('shapeReview', () => {
  it('reports the FULL findings count even when the array is truncated', () => {
    const shaped = shapeReview(
      review({ findings: [finding(), finding(), finding()] }),
      { max: 1 },
    );
    expect(shaped.findings).toHaveLength(1);
    expect(shaped.findings_count).toBe(3);
  });

  it('omits nullable review fields rather than emitting nulls', () => {
    const shaped = shapeReview(review({ verdict: null, score: null, summary: null }));
    expect(shaped).not.toHaveProperty('verdict');
    expect(shaped).not.toHaveProperty('score');
    expect(shaped).not.toHaveProperty('summary');
  });

  it('carries the agent name so the caller knows who produced it', () => {
    expect(shapeReview(review()).agent).toBe('Security Reviewer');
  });
});

describe('shapeConventions', () => {
  it('defaults to accepted only', () => {
    const shaped = shapeConventions([
      convention({ rule: 'kept', status: 'accepted' }),
      convention({ rule: 'pending', status: 'pending' }),
      convention({ rule: 'rejected', status: 'rejected' }),
    ]);
    expect(shaped.map((c) => c.rule)).toEqual(['kept']);
  });

  it('filters by the requested status', () => {
    const shaped = shapeConventions(
      [convention({ rule: 'a', status: 'accepted' }), convention({ rule: 'p', status: 'pending' })],
      { status: 'pending' },
    );
    expect(shaped.map((c) => c.rule)).toEqual(['p']);
  });

  it('orders by confidence, highest first, and truncates to max', () => {
    const shaped = shapeConventions(
      [
        convention({ rule: 'low', confidence: 0.2 }),
        convention({ rule: 'high', confidence: 0.95 }),
        convention({ rule: 'mid', confidence: 0.5 }),
      ],
      { max: 2 },
    );
    expect(shaped.map((c) => c.rule)).toEqual(['high', 'mid']);
  });

  it('drops evidence_snippet — the agent can read the file itself', () => {
    const withSnippet = { ...convention(), evidence_snippet: 'const x = 1;', id: 'abc' };
    const shaped = shapeConventions([withSnippet]);
    expect(Object.keys(shaped[0]!).sort()).toEqual([
      'category',
      'confidence',
      'evidence_line',
      'evidence_path',
      'rule',
    ]);
  });

  it('omits a nullish evidence_line instead of emitting null', () => {
    expect(shapeConventions([convention({ evidence_line: null })])[0]).not.toHaveProperty(
      'evidence_line',
    );
  });

  it('defaults max to 30, matching the verbatim tool description', () => {
    const many = Array.from({ length: 40 }, (_, i) => convention({ rule: `r${i}` }));
    expect(shapeConventions(many)).toHaveLength(DEFAULT_MAX_CONVENTIONS);
    expect(DEFAULT_MAX_CONVENTIONS).toBe(30);
  });
});

describe('shapeReviewList', () => {
  it('nests findings inside each review and sums the full total', () => {
    const out = shapeReviewList([
      review({ summary: 'a', findings: [finding(), finding()] }),
      review({ summary: 'b', findings: [finding()] }),
    ]);
    expect(out.reviews.map((r) => r.summary)).toEqual(['a', 'b']);
    expect(out.reviews[0]!.findings).toHaveLength(2);
    expect(out.total_findings).toBe(3);
  });

  it('preserves the caller order — listReviews is already newest-first', () => {
    const out = shapeReviewList([review({ summary: 'newest' }), review({ summary: 'older' })]);
    expect(out.reviews.map((r) => r.summary)).toEqual(['newest', 'older']);
  });

  it('counts full findings in total_findings even when each review truncates', () => {
    // Truncation must stay visible: a caller comparing total_findings against
    // the returned arrays can tell that raising max_findings returns more.
    const out = shapeReviewList(
      [
        review({ findings: [finding(), finding(), finding()] }),
        review({ findings: [finding(), finding()] }),
      ],
      { max: 1 },
    );
    expect(out.reviews.map((r) => r.findings.length)).toEqual([1, 1]);
    expect(out.reviews.map((r) => r.findings_count)).toEqual([3, 2]);
    expect(out.total_findings).toBe(5);
  });

  it('returns an empty list and a zero total for no reviews', () => {
    expect(shapeReviewList([])).toEqual({ reviews: [], total_findings: 0 });
  });
});
