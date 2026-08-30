import { describe, it, expect } from 'vitest';
import type { LLMProvider, StructuredResult } from '@devdigest/shared';
import { MockLLMProvider, MockGitClient } from '../../server/src/adapters/mocks.js';
import { reviewPullRequest } from '../src/index.js';

/**
 * Engine-level test for reviewPullRequest (the core lifted out of the server's
 * runOneAgent). Uses the server's mock LLM + git so we exercise the real
 * assemble → completeStructured → reduce → grounding pipeline with no DB/SSE.
 */
describe('reviewPullRequest (engine)', () => {
  // One grounded finding (line 11 is in the MockGitClient diff) + one
  // hallucinated finding (line 999) the grounding gate must drop.
  const fixture = {
    verdict: 'request_changes',
    summary: 'secret key committed',
    score: 38,
    findings: [
      {
        id: 'f1',
        severity: 'CRITICAL',
        category: 'security',
        title: 'Hardcoded Stripe secret key',
        file: 'src/config.ts',
        start_line: 11,
        end_line: 11,
        rationale: 'sk_live in diff',
        confidence: 0.98,
        kind: 'finding',
      },
      {
        id: 'f-hallucinated',
        severity: 'WARNING',
        category: 'bug',
        title: 'phantom finding on a line not in the diff',
        file: 'src/config.ts',
        start_line: 999,
        end_line: 999,
        rationale: 'not real',
        confidence: 0.3,
        kind: 'finding',
      },
    ],
  };

  it('single-pass: assembles, grounds, drops the hallucinated finding', async () => {
    const llm = new MockLLMProvider('openai', { structured: fixture });
    const diff = await new MockGitClient().diff();

    const events: string[] = [];
    const outcome = await reviewPullRequest({
      systemPrompt: 'security reviewer',
      model: 'gpt-4.1',
      diff,
      llm,
      task: 'Review PR #482',
      onEvent: (e) => events.push(e.msg),
    });

    expect(outcome.mode).toBe('single-pass');
    expect(outcome.grounding).toBe('1/2 passed');
    expect(outcome.review.findings).toHaveLength(1);
    expect(outcome.review.findings[0]!.start_line).toBe(11);
    expect(outcome.dropped).toHaveLength(1);
    // Score is derived from the SURVIVING findings, not the model's self-reported
    // 38: one CRITICAL remains after grounding ⇒ 100 − 35 = 65.
    expect(outcome.review.score).toBe(65);
    // progress is surfaced (server bridges this onto SSE; runner logs it)
    expect(events.some((m) => m.includes('Citation grounding'))).toBe(true);
  });

  it('score is deterministic from findings: a clean approve scores 100', async () => {
    // Model "approves" but reports a nonsense low score (the cheap-model bug).
    // The engine must ignore that and score the zero findings as a perfect 100.
    const clean = { verdict: 'approve', summary: 'looks good', score: 10, findings: [] };
    const llm = new MockLLMProvider('openai', { structured: clean });
    const diff = await new MockGitClient().diff();

    const outcome = await reviewPullRequest({
      systemPrompt: 'security reviewer',
      model: 'deepseek/deepseek-v4-flash',
      diff,
      llm,
      task: 'Review PR #5',
    });

    expect(outcome.review.findings).toHaveLength(0);
    expect(outcome.review.score).toBe(100);
  });

  it('checkCancelled throwing aborts before the LLM call', async () => {
    const llm = new MockLLMProvider('openai', { structured: fixture });
    const diff = await new MockGitClient().diff();
    await expect(
      reviewPullRequest({
        systemPrompt: 's',
        model: 'gpt-4.1',
        diff,
        llm,
        checkCancelled: () => {
          throw new Error('cancelled');
        },
      }),
    ).rejects.toThrow('cancelled');
  });

  it('forwards sessionId to every LLM call (OpenRouter session grouping)', async () => {
    const seen: (string | undefined)[] = [];
    const recorder: LLMProvider = {
      id: 'openrouter',
      async completeStructured<T>(req): Promise<StructuredResult<T>> {
        seen.push(req.sessionId);
        return {
          data: fixture as unknown as T,
          model: req.model,
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
          raw: '',
          attempts: 1,
        };
      },
      async listModels() {
        return [];
      },
      async complete() {
        throw new Error('not used');
      },
      async embed() {
        return [];
      },
    };
    const diff = await new MockGitClient().diff();
    await reviewPullRequest({ systemPrompt: 's', model: 'm', diff, llm: recorder, sessionId: 'sess-abc' });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s === 'sess-abc')).toBe(true);
  });
});

/**
 * The pipeline order that keeps score, findings and events consistent:
 * ground → scope → score. A finding grounding already dropped can never turn
 * up in `demoted`, and the score is computed from POST-demotion severities.
 */
describe('reviewPullRequest — scope filter placement', () => {
  // 1 exempt CRITICAL + 1 demotable style WARNING, both on line 11 (in the mock
  // diff), plus a style WARNING at line 999 that grounding must drop first.
  const scoped = {
    verdict: 'request_changes',
    summary: 'mixed',
    score: 50,
    findings: [
      {
        id: 'f-critical',
        severity: 'CRITICAL',
        category: 'security',
        title: 'Hardcoded Stripe secret key',
        file: 'src/config.ts',
        start_line: 11,
        end_line: 11,
        rationale: 'sk_live in diff',
        confidence: 0.98,
        kind: 'finding',
      },
      {
        id: 'f-style',
        severity: 'WARNING',
        category: 'style',
        title: 'Quote style is inconsistent with the file',
        file: 'src/config.ts',
        start_line: 11,
        end_line: 11,
        rationale: 'double quotes',
        confidence: 0.5,
        kind: 'finding',
      },
      {
        id: 'f-hallucinated',
        severity: 'WARNING',
        category: 'style',
        title: 'phantom nit on a line not in the diff',
        file: 'src/config.ts',
        start_line: 999,
        end_line: 999,
        rationale: 'not real',
        confidence: 0.2,
        kind: 'finding',
      },
    ],
  };

  const intent = {
    intent: 'Bump the redis timeout',
    in_scope: ['src/redis/'],
    out_of_scope: ['src/config.ts'],
    confidence_level: 'high' as const,
  };

  async function run(over: Partial<Parameters<typeof reviewPullRequest>[0]> = {}) {
    const llm = new MockLLMProvider('openai', { structured: scoped });
    const diff = await new MockGitClient().diff();
    const events: string[] = [];
    const outcome = await reviewPullRequest({
      systemPrompt: 'reviewer',
      model: 'gpt-4.1',
      diff,
      llm,
      onEvent: (e) => events.push(e.msg),
      ...over,
    });
    return { outcome, events };
  }

  it('grounds first, then demotes, then scores from the demoted severities', async () => {
    const { outcome, events } = await run({ intent });

    // grounding ran first and still dropped the phantom
    expect(outcome.grounding).toBe('2/3 passed');
    expect(outcome.dropped).toHaveLength(1);
    // …so it can never appear as a demotion, even though it matched the entry
    expect(outcome.demoted.map((d) => d.finding.id)).toEqual(['f-style']);

    // demotion, never deletion
    expect(outcome.review.findings).toHaveLength(2);
    const style = outcome.review.findings.find((f) => f.id === 'f-style')!;
    expect(style.severity).toBe('SUGGESTION');
    expect(style.out_of_scope).toBe(true);
    expect(style.scope_note).toContain('demoted WARNING→SUGGESTION');

    // the CRITICAL security finding is untouched by the escape hatch
    const crit = outcome.review.findings.find((f) => f.id === 'f-critical')!;
    expect(crit.severity).toBe('CRITICAL');
    expect(crit.out_of_scope ?? null).toBeNull();

    // score uses POST-demotion severities: 100 − 35 (CRITICAL) − 3 (SUGGESTION)
    expect(outcome.review.score).toBe(62);

    expect(
      events.some((m) => m.startsWith('scope: demoted "Quote style is inconsistent with the file"')),
    ).toBe(true);
  });

  it('logs the no-op instead of demoting when intent confidence is low', async () => {
    const { outcome, events } = await run({ intent: { ...intent, confidence_level: 'low' } });

    expect(outcome.demoted).toHaveLength(0);
    expect(outcome.review.findings.find((f) => f.id === 'f-style')!.severity).toBe('WARNING');
    // 100 − 35 (CRITICAL) − 12 (WARNING)
    expect(outcome.review.score).toBe(53);
    expect(events).toContain('scope: intent confidence low — no findings demoted');
  });

  it('is entirely silent and inert when no intent is supplied', async () => {
    const { outcome, events } = await run();

    expect(outcome.demoted).toHaveLength(0);
    expect(outcome.review.score).toBe(53);
    expect(events.some((m) => m.startsWith('scope:'))).toBe(false);
    expect(outcome.assembly.intent ?? null).toBeNull();
  });
});
