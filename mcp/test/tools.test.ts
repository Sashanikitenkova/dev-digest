import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NO_CONVENTIONS_MESSAGE,
  STILL_RUNNING_MESSAGE,
} from '../src/errors.js';
import { resetResolverCache } from '../src/resolve.js';
import type { ToolResult } from '../src/shape.js';
import { getBlastRadius } from '../src/tools/get-blast-radius.js';
import { getConventions } from '../src/tools/get-conventions.js';
import { getFindings } from '../src/tools/get-findings.js';
import { listAgents } from '../src/tools/list-agents.js';
import { DEFAULT_TIMEOUT_MS, runAgentOnPr } from '../src/tools/run-agent-on-pr.js';
import {
  agent,
  blast,
  convention,
  finding,
  pull,
  repo,
  review,
  run,
  stubContext,
} from './stub-api.js';

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

// ---- get_blast_radius -----------------------------------------------------

describe('get_blast_radius', () => {
  const withBlast = (over: Parameters<typeof blast>[0]) =>
    happyContext({ blast: { [PULL_ID]: blast(over) } });

  it('shapes the impact map, collapsing callers to path:line', async () => {
    const ctx = withBlast({
      changed_symbols: [{ name: 'rateLimit', file: 'src/api/rateLimit.ts', kind: 'function' }],
      downstream: [
        {
          symbol: 'rateLimit',
          callers: [
            { name: 'handler', file: 'src/api/public/index.ts', line: 23 },
            { name: 'boot', file: 'src/server.ts', line: 88 },
          ],
          caller_total: 2,
          endpoints_affected: [
            { endpoint: 'GET /api/public/items', depth: 1 },
            { endpoint: 'GET /health', depth: 2 },
          ],
          crons_affected: [],
        },
      ],
      impacted_endpoints: ['GET /api/public/items'],
      summary: '1 changed symbol, 2 callers, 1 impacted endpoint.',
    });

    const result = await getBlastRadius(ctx, { repo: 'acme/payments-api', pr: 482 });

    expect(result.isError).toBeUndefined();
    expect(structured(result)).toMatchObject({
      status: 'ok',
      index_status: 'full',
      changed_symbols: 1,
      symbols: [
        {
          symbol: 'rateLimit',
          file: 'src/api/rateLimit.ts',
          callers: ['src/api/public/index.ts:23', 'src/server.ts:88'],
          caller_total: 2,
          // Separate keys, not one list: a 2-hop endpoint is reached through a
          // module in between, and the model must not weigh it as a direct hit.
          endpoints: ['GET /api/public/items'],
          endpoints_indirect: ['GET /health'],
        },
      ],
    });
  });

  it('reports an unindexed repo as not_indexed, never as an empty map', async () => {
    const ctx = withBlast({ index: { status: 'missing', reason: 'no_data', files_indexed: 0 } });

    const result = await getBlastRadius(ctx, { repo: 'acme/payments-api', pr: 482 });

    // The distinction the whole tool rests on: absence of evidence is not
    // evidence of absence, and a model told "no impact" would act on it.
    expect(structured(result).status).toBe('not_indexed');
    expect(structured(result).symbols).toBeUndefined();
  });

  it('is isError: false for an unindexed repo — a known state, not a mistake', async () => {
    const ctx = withBlast({ index: { status: 'missing', reason: null, files_indexed: 0 } });
    expect((await getBlastRadius(ctx, { repo: 'acme/payments-api', pr: 482 })).isError)
      .toBeUndefined();
  });

  it('caveats a partial index in the payload rather than leaving it inferable', async () => {
    const ctx = withBlast({ index: { status: 'partial', reason: 'soft_budget', files_indexed: 9 } });

    const shaped = structured(await getBlastRadius(ctx, { repo: 'acme/payments-api', pr: 482 }));

    expect(shaped.index_status).toBe('partial');
    expect(String(shaped.caveat)).toMatch(/not known/);
  });

  it('omits the caveat when the index is complete', async () => {
    const shaped = structured(
      await getBlastRadius(withBlast({}), { repo: 'acme/payments-api', pr: 482 }),
    );
    expect(shaped.caveat).toBeUndefined();
  });

  it('surfaces an unknown repository as a correctable error', async () => {
    const ctx = happyContext();
    await expect(getBlastRadius(ctx, { repo: 'nope/nope', pr: 1 })).rejects.toThrow(
      /is not imported into DevDigest/,
    );
  });
});

// ---- get_findings ---------------------------------------------------------

/** One entry of the `reviews` array, as it appears on the wire. */
type OutReview = {
  agent?: string;
  summary?: string;
  findings_count: number;
  findings: Array<{ title: string; rationale?: string }>;
};

const reviewsOf = (result: ToolResult): OutReview[] =>
  (structured(result)['reviews'] ?? []) as OutReview[];

describe('get_findings', () => {
  it('returns EVERY review on the pull request, newest first, findings nested', async () => {
    // A PR has one review per agent; returning only the newest hid the rest.
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
    expect(reviewsOf(result).map((r) => r.summary)).toEqual(['newest', 'older']);
    expect(reviewsOf(result)[0]!.findings_count).toBe(1);
  });

  it('sums total_findings across every returned review', async () => {
    const ctx = happyContext({
      reviews: {
        [PULL_ID]: [
          review({ id: 'a', findings: [finding(), finding()] }),
          review({ id: 'b', findings: [finding()] }),
        ],
      },
    });
    const result = await getFindings(ctx, { repo: 'acme/payments-api', pr: 482 });
    expect(structured(result)['total_findings']).toBe(3);
  });

  it('omits rationale by default', async () => {
    const ctx = happyContext({
      reviews: { [PULL_ID]: [review({ findings: [finding()] })] },
    });
    const result = await getFindings(ctx, { repo: 'acme/payments-api', pr: 482 });
    expect(JSON.stringify(structured(result))).not.toContain('rationale');
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

  it('skips the multi-agent summary roll-up row and keeps only review rows', async () => {
    const ctx = happyContext({
      reviews: {
        [PULL_ID]: [
          review({ id: 'roll-up', kind: 'summary', summary: 'roll-up' }),
          review({ id: 'real', kind: 'review', summary: 'real' }),
        ],
      },
    });
    const result = await getFindings(ctx, { repo: 'acme/payments-api', pr: 482 });
    expect(reviewsOf(result).map((r) => r.summary)).toEqual(['real']);
  });

  it('narrows the list to one agent when one is named', async () => {
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
    expect(reviewsOf(result).map((r) => r.summary)).toEqual(['security']);
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
    expect(structured(result)['reviews']).toBeUndefined();
    expect(String(structured(result)['message'])).toContain('Call run_agent_on_pr');
  });

  it('truncates to max_findings per review while reporting the full count', async () => {
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
    const first = reviewsOf(result)[0]!;
    expect(first.findings_count).toBe(3);
    expect(first.findings).toHaveLength(1);
    expect(first.findings[0]!.title).toBe('c');
  });

  it('applies max_findings PER review, and total_findings stays untruncated', async () => {
    const ctx = happyContext({
      reviews: {
        [PULL_ID]: [
          review({ id: 'a', findings: [finding(), finding()] }),
          review({ id: 'b', findings: [finding(), finding()] }),
        ],
      },
    });
    const result = await getFindings(ctx, {
      repo: 'acme/payments-api',
      pr: 482,
      max_findings: 1,
    });
    // Each review keeps one finding — the cap is not a global budget that
    // would starve whichever review happens to be iterated last.
    expect(reviewsOf(result).map((r) => r.findings.length)).toEqual([1, 1]);
    expect(structured(result)['total_findings']).toBe(4);
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
