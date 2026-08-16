import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BLAST_RADIUS_STUB_MESSAGE,
  NO_CONVENTIONS_MESSAGE,
  STILL_RUNNING_MESSAGE,
} from '../src/errors.js';
import { resetResolverCache } from '../src/resolve.js';
import { getBlastRadius } from '../src/tools/get-blast-radius.js';
import { getConventions } from '../src/tools/get-conventions.js';
import { getFindings } from '../src/tools/get-findings.js';
import { listAgents } from '../src/tools/list-agents.js';
import { DEFAULT_TIMEOUT_MS, runAgentOnPr } from '../src/tools/run-agent-on-pr.js';
import { agent, convention, finding, pull, repo, review, run, stubContext } from './stub-api.js';

/**
 * APPLICATION ring — every tool end-to-end over the stub port.
 *
 * Nothing here mocks `fetch`, spawns a process, or needs the API running. That
 * is the whole reason `DevDigestApi` exists as a port.
 */
beforeEach(() => resetResolverCache());

const REPO_ID = '22222222-2222-4222-8222-222222222222';
const PULL_ID = '33333333-3333-4333-8333-333333333333';
const AGENT_ID = '11111111-1111-4111-8111-111111111111';

/** The seeded happy path: one repo, one PR, one agent. */
function happyContext(extra: Parameters<typeof stubContext>[0] = {}) {
  return stubContext({
    repos: [repo()],
    pulls: { [REPO_ID]: [pull()] },
    agents: [agent()],
    ...extra,
  });
}

function structured(result: { structuredContent?: Record<string, unknown> }) {
  return result.structuredContent ?? {};
}

// ---- list_agents ----------------------------------------------------------

describe('list_agents', () => {
  it('returns the shaped agent list', async () => {
    const ctx = happyContext();
    const result = await listAgents(ctx);
    expect(result.isError).toBeUndefined();
    expect(structured(result)).toEqual({
      agents: [
        {
          name: 'Security Reviewer',
          description: 'Finds security issues.',
          model: 'anthropic/claude-sonnet-4',
          enabled: true,
        },
      ],
    });
  });

  it('returns an empty list rather than failing when nothing is configured', async () => {
    const result = await listAgents(stubContext());
    expect(result.isError).toBeUndefined();
    expect(structured(result)).toEqual({ agents: [] });
  });
});

// ---- get_conventions ------------------------------------------------------

describe('get_conventions', () => {
  it('returns accepted conventions by default', async () => {
    const ctx = happyContext({
      conventions: {
        [REPO_ID]: [convention({ rule: 'yes' }), convention({ rule: 'no', status: 'pending' })],
      },
    });
    const result = await getConventions(ctx, { repo: 'acme/payments-api' });
    expect(structured(result)['conventions']).toEqual([
      {
        rule: 'yes',
        category: 'testing',
        evidence_path: 'server/test/reviews.it.test.ts',
        evidence_line: 1,
        confidence: 0.9,
      },
    ]);
  });

  it('returns the "never extracted" guidance when there are zero rows', async () => {
    const ctx = happyContext({ conventions: { [REPO_ID]: [] } });
    const result = await getConventions(ctx, { repo: 'acme/payments-api' });

    // Empty is meaningful, not an error: rows are precomputed and never lazily
    // extracted, so [] means "the extractor never ran".
    expect(result.isError).toBeUndefined();
    expect(structured(result)).toEqual({ conventions: [], message: NO_CONVENTIONS_MESSAGE });
  });

  it('does NOT claim "never extracted" when the status filter emptied the list', async () => {
    const ctx = happyContext({
      conventions: {
        [REPO_ID]: [convention({ status: 'pending' }), convention({ status: 'pending' })],
      },
    });
    const result = await getConventions(ctx, { repo: 'acme/payments-api' });

    expect(result.isError).toBeUndefined();
    const message = String(structured(result)['message']);
    expect(message).not.toBe(NO_CONVENTIONS_MESSAGE);
    expect(message).toContain('2 conventions were extracted');
    expect(message).toContain('none have status "accepted"');
  });

  it('honours an explicit status', async () => {
    const ctx = happyContext({
      conventions: { [REPO_ID]: [convention({ rule: 'p', status: 'pending' })] },
    });
    const result = await getConventions(ctx, { repo: 'acme/payments-api', status: 'pending' });
    expect(structured(result)['conventions']).toHaveLength(1);
  });

  it('fails forward when the repository is not imported', async () => {
    const ctx = happyContext();
    const result = await getConventions(ctx, { repo: 'acme/unknown' }).catch((e: Error) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/is not imported into DevDigest/);
  });
});

// ---- get_blast_radius (stub) ---------------------------------------------

describe('get_blast_radius', () => {
  it('returns the not-implemented payload and never throws', () => {
    const result = getBlastRadius({ repo: 'acme/payments-api', pr: 482 });
    expect(result.isError).toBeUndefined();
    expect(structured(result)).toEqual({
      implemented: false,
      message: BLAST_RADIUS_STUB_MESSAGE,
    });
  });

  it('is isError: false — "not implemented" is a known state, not a model mistake', () => {
    expect(getBlastRadius({ repo: 'x/y', pr: 1 }).isError).toBeUndefined();
  });

  it('makes zero API calls — it would spend a slow PR sync for a fixed message', () => {
    const ctx = happyContext();
    getBlastRadius({ repo: 'acme/payments-api', pr: 482 });
    expect(Object.values(ctx.api.calls).every((n) => n === 0)).toBe(true);
  });

  it('does not throw even for a repository that does not exist', () => {
    expect(() => getBlastRadius({ repo: 'nope/nope', pr: 0 })).not.toThrow();
  });
});

// ---- get_findings ---------------------------------------------------------

describe('get_findings', () => {
  it('returns the newest review, shaped, without rationale by default', async () => {
    const ctx = happyContext({
      reviews: {
        [PULL_ID]: [
          review({ id: 'newest', summary: 'newest', findings: [finding()] }),
          review({ id: 'older', summary: 'older' }),
        ],
      },
    });
    const result = await getFindings(ctx, { repo: 'acme/payments-api', pr: 482 });
    const out = structured(result);

    expect(out['status']).toBe('ok');
    expect(out['summary']).toBe('newest');
    expect(out['findings_count']).toBe(1);
    expect(JSON.stringify(out)).not.toContain('rationale');
  });

  it('adds rationale and confidence under detail: true', async () => {
    const ctx = happyContext({
      reviews: { [PULL_ID]: [review({ findings: [finding()] })] },
    });
    const result = await getFindings(ctx, {
      repo: 'acme/payments-api',
      pr: 482,
      detail: true,
    });
    expect(JSON.stringify(structured(result))).toContain('rationale');
  });

  it('skips the multi-agent summary roll-up row and takes the review row', async () => {
    const ctx = happyContext({
      reviews: {
        [PULL_ID]: [
          review({ id: 'roll-up', kind: 'summary', summary: 'roll-up' }),
          review({ id: 'real', kind: 'review', summary: 'real' }),
        ],
      },
    });
    const result = await getFindings(ctx, { repo: 'acme/payments-api', pr: 482 });
    expect(structured(result)['summary']).toBe('real');
  });

  it('filters by agent when one is named', async () => {
    const ctx = happyContext({
      agents: [agent(), agent({ id: 'other-agent', name: 'API Contract Reviewer' })],
      reviews: {
        [PULL_ID]: [
          review({ id: 'a', agent_id: 'other-agent', summary: 'contract' }),
          review({ id: 'b', agent_id: AGENT_ID, summary: 'security' }),
        ],
      },
    });
    const result = await getFindings(ctx, {
      repo: 'acme/payments-api',
      pr: 482,
      agent: 'Security Reviewer',
    });
    expect(structured(result)['summary']).toBe('security');
  });

  it('ignores rows whose agent_id is null when filtering by agent', async () => {
    const ctx = happyContext({
      reviews: { [PULL_ID]: [review({ agent_id: null })] },
    });
    const result = await getFindings(ctx, {
      repo: 'acme/payments-api',
      pr: 482,
      agent: 'Security Reviewer',
    });
    expect(structured(result)['status']).toBe('no_review');
  });

  it('reports "no review yet" as a healthy state, not an error', async () => {
    const ctx = happyContext({ reviews: { [PULL_ID]: [] } });
    const result = await getFindings(ctx, { repo: 'acme/payments-api', pr: 482 });

    expect(result.isError).toBeUndefined();
    expect(structured(result)['status']).toBe('no_review');
    expect(String(structured(result)['message'])).toContain('Call run_agent_on_pr');
  });

  it('truncates to max_findings while reporting the full count', async () => {
    const ctx = happyContext({
      reviews: {
        [PULL_ID]: [
          review({
            findings: [
              finding({ severity: 'SUGGESTION', title: 's' }),
              finding({ severity: 'CRITICAL', title: 'c' }),
              finding({ severity: 'WARNING', title: 'w' }),
            ],
          }),
        ],
      },
    });
    const result = await getFindings(ctx, {
      repo: 'acme/payments-api',
      pr: 482,
      max_findings: 1,
    });
    const out = structured(result);
    expect(out['findings_count']).toBe(3);
    expect(out['findings']).toHaveLength(1);
    expect((out['findings'] as Array<{ title: string }>)[0]!.title).toBe('c');
  });
});

// ---- run_agent_on_pr ------------------------------------------------------

describe('run_agent_on_pr', () => {
  afterEach(() => vi.useRealTimers());

  it('starts the run, polls until terminal, then returns the findings', async () => {
    const ctx = happyContext({
      runSequence: [[run({ status: 'running' })], [run({ status: 'running' })], [run({ status: 'done' })]],
      reviews: { [PULL_ID]: [review({ run_id: 'run-1', findings: [finding()] })] },
    });

    const result = await runAgentOnPr(
      ctx,
      { repo: 'acme/payments-api', pr: 482, agent: 'Security Reviewer' },
      { pollIntervalMs: 0 },
    );
    const out = structured(result);

    expect(ctx.api.startReviewArgs).toEqual([{ pullId: PULL_ID, agentId: AGENT_ID }]);
    expect(ctx.api.calls.listRuns).toBe(3);
    expect(out['status']).toBe('done');
    expect(out['run_id']).toBe('run-1');
    expect(out['verdict']).toBe('request_changes');
    expect(out['findings_count']).toBe(1);
  });

  it('omits rationale — it lives behind get_findings({ detail: true })', async () => {
    const ctx = happyContext({
      runSequence: [[run({ status: 'done' })]],
      reviews: { [PULL_ID]: [review({ findings: [finding()] })] },
    });
    const result = await runAgentOnPr(
      ctx,
      { repo: 'acme/payments-api', pr: 482, agent: 'Security Reviewer' },
      { pollIntervalMs: 0 },
    );
    expect(JSON.stringify(structured(result))).not.toContain('rationale');
  });

  it('treats a null status as still running rather than as terminal', async () => {
    const ctx = happyContext({
      runSequence: [[run({ status: null })], [run({ status: 'done' })]],
      reviews: { [PULL_ID]: [review()] },
    });
    const result = await runAgentOnPr(
      ctx,
      { repo: 'acme/payments-api', pr: 482, agent: 'Security Reviewer' },
      { pollIntervalMs: 0 },
    );
    expect(structured(result)['status']).toBe('done');
    expect(ctx.api.calls.listRuns).toBe(2);
  });

  it('reports a failed run with its error, and does not throw', async () => {
    const ctx = happyContext({
      runSequence: [[run({ status: 'failed', error: 'provider returned 401' })]],
    });

    const result = await runAgentOnPr(
      ctx,
      { repo: 'acme/payments-api', pr: 482, agent: 'Security Reviewer' },
      { pollIntervalMs: 0 },
    );

    // A genuinely failed operation IS isError — but the structured payload
    // still travels, because run_id is what the user looks the failure up by.
    expect(result.isError).toBe(true);
    expect(structured(result)).toEqual({
      status: 'failed',
      run_id: 'run-1',
      message: expect.stringContaining('provider returned 401'),
    });
  });

  it('reports a cancelled run the same way', async () => {
    const ctx = happyContext({ runSequence: [[run({ status: 'cancelled' })]] });
    const result = await runAgentOnPr(
      ctx,
      { repo: 'acme/payments-api', pr: 482, agent: 'Security Reviewer' },
      { pollIntervalMs: 0 },
    );
    expect(result.isError).toBe(true);
    expect(structured(result)['status']).toBe('cancelled');
  });

  it('never fetches reviews for a run that did not succeed', async () => {
    const ctx = happyContext({ runSequence: [[run({ status: 'failed' })]] });
    await runAgentOnPr(
      ctx,
      { repo: 'acme/payments-api', pr: 482, agent: 'Security Reviewer' },
      { pollIntervalMs: 0 },
    );
    expect(ctx.api.calls.listReviews).toBe(0);
  });

  it('hands back the still_running shape after 5 minutes instead of hanging', async () => {
    vi.useFakeTimers();
    const ctx = happyContext({ runSequence: [[run({ status: 'running' })]] });

    const promise = runAgentOnPr(ctx, {
      repo: 'acme/payments-api',
      pr: 482,
      agent: 'Security Reviewer',
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS + 2_000);
    const result = await promise;

    expect(result.isError).toBeUndefined();
    expect(structured(result)).toEqual({
      status: 'still_running',
      run_id: 'run-1',
      message: STILL_RUNNING_MESSAGE,
    });
  });

  it('reports a run that finished without persisting a review', async () => {
    const ctx = happyContext({
      runSequence: [[run({ status: 'done' })]],
      reviews: { [PULL_ID]: [review({ run_id: 'a-different-run' })] },
    });
    const result = await runAgentOnPr(
      ctx,
      { repo: 'acme/payments-api', pr: 482, agent: 'Security Reviewer' },
      { pollIntervalMs: 0 },
    );
    expect(result.isError).toBeUndefined();
    expect(structured(result)['status']).toBe('done');
    expect(String(structured(result)['message'])).toContain('produced no stored review');
  });

  it('ignores a review row whose run_id is null', async () => {
    const ctx = happyContext({
      runSequence: [[run({ status: 'done' })]],
      reviews: { [PULL_ID]: [review({ run_id: null })] },
    });
    const result = await runAgentOnPr(
      ctx,
      { repo: 'acme/payments-api', pr: 482, agent: 'Security Reviewer' },
      { pollIntervalMs: 0 },
    );
    expect(String(structured(result)['message'])).toContain('produced no stored review');
  });

  it('reports an accepted request that started no run', async () => {
    const ctx = happyContext({ startReview: { pr_id: PULL_ID, runs: [] } });
    const result = await runAgentOnPr(
      ctx,
      { repo: 'acme/payments-api', pr: 482, agent: 'Security Reviewer' },
      { pollIntervalMs: 0 },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('started no run');
  });

  it('rejects a bad agent name BEFORE paying for the slow PR sync', async () => {
    const ctx = happyContext();
    await expect(
      runAgentOnPr(ctx, { repo: 'acme/payments-api', pr: 482, agent: 'Nope' }, {}),
    ).rejects.toThrow(/^agent not found — call list_agents/);

    expect(ctx.api.calls.listPulls).toBe(0);
    expect(ctx.api.calls.startReview).toBe(0);
  });
});
