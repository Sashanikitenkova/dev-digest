import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Review } from '@devdigest/shared';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { waitForPrRuns } from './helpers/runs.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import {
  MockLLMProvider,
  MockEmbedder,
  MockGitClient,
  MockGitHubClient,
} from '../src/adapters/mocks.js';
import * as t from '../src/db/schema.js';

/**
 * Intent layer, end to end against a real Postgres.
 *
 * The load-bearing assertions here are the ones a unit test cannot make:
 *   • detection persists a source LEDGER, not just a sentence
 *   • an unreachable plan/spec is reported missing, never invented
 *   • the classifier prompt contains no diff bodies
 *   • a review run produces TWO distinct LLM calls, both visible in the trace
 */

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const config = () => loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);

const DIFF = `diff --git a/src/config.ts b/src/config.ts
--- a/src/config.ts
+++ b/src/config.ts
@@ -10,3 +10,4 @@
   port: 3000,
+  stripeKey: "sk_live_xxx",
   redisUrl: x,`;

const INTENT_FIXTURE = {
  intent: 'Add rate limiting to the public API endpoints.',
  in_scope: ['Add rate limiting middleware', 'Apply to /api/public/* routes'],
  out_of_scope: ['CSS and theming'],
  confidence: 0.9,
};

const REVIEW_FIXTURE: Review = {
  verdict: 'request_changes',
  summary: 'Hardcoded Stripe secret introduced.',
  score: 42,
  findings: [
    {
      id: 'f-sec',
      severity: 'CRITICAL',
      category: 'security',
      title: 'Hardcoded Stripe secret key',
      file: 'src/config.ts',
      start_line: 11,
      end_line: 11,
      rationale: 'A live Stripe key is committed in source.',
      confidence: 0.95,
      kind: 'finding',
    },
  ],
};

let repoSeq = 0;
async function setupRepoAndPr(
  db: PgFixture['handle']['db'],
  workspaceId: string,
  body: string | null,
) {
  const name = `intent-api-${repoSeq++}`;
  const [repo] = await db
    .insert(t.repos)
    .values({ workspaceId, owner: 'acme', name, fullName: `acme/${name}` })
    .returning();
  const [pr] = await db
    .insert(t.pullRequests)
    .values({
      workspaceId,
      repoId: repo!.id,
      number: 482,
      title: 'Add rate limiting to public API endpoints',
      author: 'marisa.koch',
      branch: 'feat/rate-limit',
      base: 'main',
      headSha: 'a1b2c3d4',
      additions: 1,
      deletions: 0,
      filesCount: 1,
      status: 'needs_review',
      body,
    })
    .returning();
  await db.insert(t.prFiles).values({
    prId: pr!.id,
    path: 'src/config.ts',
    additions: 1,
    deletions: 0,
    patch: '@@ -10,3 +10,4 @@\n   port: 3000,\n+  stripeKey: "sk_live_xxx",\n   redisUrl: x,',
  });
  return { repo: repo!, pr: pr! };
}

d('Intent layer (Testcontainers pg)', () => {
  let pg: PgFixture;
  let workspaceId: string;

  beforeAll(async () => {
    pg = await startPg();
    await seed(pg.handle.db);
    const [ws] = await pg.handle.db.select().from(t.workspaces);
    workspaceId = ws!.id;
  });
  afterAll(async () => {
    await pg?.stop();
  });

  /** The intent classifier resolves `review_intent` → openrouter by default. */
  function appWith(opts: { files?: Record<string, string> } = {}) {
    const intentLlm = new MockLLMProvider('openai', { structured: INTENT_FIXTURE });
    const reviewLlm = new MockLLMProvider('openai', { structured: REVIEW_FIXTURE });
    const app = buildApp({
      config: config(),
      db: pg.handle.db,
      overrides: {
        embedder: new MockEmbedder(),
        github: new MockGitHubClient(),
        git: new MockGitClient({ diff: DIFF, ...(opts.files ? { files: opts.files } : {}) }),
        llm: {
          // review_intent's registry default provider
          openrouter: intentLlm as never,
          // the seeded agents' provider
          openai: reviewLlm as never,
        },
      },
    });
    return { app, intentLlm, reviewLlm };
  }

  it('detects intent and persists the source ledger', async () => {
    const { app, intentLlm } = appWith();
    const { pr } = await setupRepoAndPr(
      pg.handle.db,
      workspaceId,
      'Add rate limiting to every public endpoint so unauthenticated clients cannot ' +
        'abuse the API. Returns 429 with a Retry-After header. Closes #471.',
    );

    const res = await (await app).inject({
      method: 'POST',
      url: `/pulls/${pr.id}/intent/detect`,
    });
    expect(res.statusCode).toBe(200);
    const intent = res.json();

    expect(intent.intent).toBe(INTENT_FIXTURE.intent);
    expect(intent.in_scope).toEqual(INTENT_FIXTURE.in_scope);
    expect(intent.head_sha).toBe('a1b2c3d4');

    // Body + linked issue were both assembled → the ceiling allows high.
    const kinds = Object.fromEntries(
      intent.sources.map((s: { kind: string; status: string }) => [s.kind, s.status]),
    );
    expect(kinds.title).toBe('used');
    expect(kinds.body).toBe('used');
    expect(kinds.linked_issue).toBe('used');
    expect(kinds.file_list).toBe('used');
    expect(intent.confidence_level).toBe('high');

    // Persisted, not just returned.
    const [row] = await pg.handle.db
      .select()
      .from(t.prIntent)
      .where(eq(t.prIntent.prId, pr.id));
    expect(row?.confidenceLevel).toBe('high');
    expect(row?.model).toBe('deepseek/deepseek-v4-flash');

    // And the classifier saw exactly one call, with no diff body in it.
    const call = intentLlm.calls.find((c) => c.method === 'completeStructured');
    const prompt = JSON.stringify((call?.req as { messages: unknown }).messages);
    expect(prompt).toContain('@@ -10,3 +10,4 @@');
    expect(prompt).not.toContain('sk_live_xxx');

    await (await app).close();
  });

  it('reports a referenced plan that is not in the clone as missing, never invented', async () => {
    const { app } = appWith();
    const { pr } = await setupRepoAndPr(
      pg.handle.db,
      workspaceId,
      'Implements the plan in docs/rate-limit-plan.md. See https://notion.so/spec too. ' +
        'This description is long enough to count as substantial context for the classifier.',
    );

    const intent = (
      await (await app).inject({ method: 'POST', url: `/pulls/${pr.id}/intent/detect` })
    ).json();

    const spec = intent.sources.find((s: { kind: string }) => s.kind === 'spec_file');
    expect(spec.status).toBe('missing');
    expect(spec.ref).toBe('docs/rate-limit-plan.md');

    const url = intent.sources.find((s: { kind: string }) => s.kind === 'url');
    expect(url.status).toBe('missing');
    expect(url.reason).toBe('external_fetch_disabled');

    // A missing non-url source caps the deterministic ceiling at medium, even
    // though the model reported 0.9.
    expect(intent.confidence_level).toBe('medium');

    await (await app).close();
  });

  it('reads a plan that IS in the clone and counts it as corroboration', async () => {
    const { app } = appWith({
      files: { 'docs/plan.md': '# Rate limiting plan\n\nToken bucket per API key.' },
    });
    const { pr } = await setupRepoAndPr(
      pg.handle.db,
      workspaceId,
      'Implements docs/plan.md — a token-bucket limiter applied to the public API surface, ' +
        'returning 429 with Retry-After when a caller exceeds its quota.',
    );

    const intent = (
      await (await app).inject({ method: 'POST', url: `/pulls/${pr.id}/intent/detect` })
    ).json();

    const spec = intent.sources.find((s: { kind: string }) => s.kind === 'spec_file');
    expect(spec.status).toBe('used');
    expect(spec.ref).toBe('docs/plan.md');
    expect(intent.confidence_level).toBe('high');

    await (await app).close();
  });

  it('falls back to title + files with LOW confidence when the PR has no description', async () => {
    const { app } = appWith();
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId, null);

    const intent = (
      await (await app).inject({ method: 'POST', url: `/pulls/${pr.id}/intent/detect` })
    ).json();

    const body = intent.sources.find((s: { kind: string }) => s.kind === 'body');
    expect(body.status).toBe('missing');
    expect(body.reason).toBe('empty_body');
    expect(intent.confidence_level).toBe('low');
    // The model claimed 0.9; the source ceiling overrides it.
    expect(intent.confidence).toBeLessThan(0.5);

    await (await app).close();
  });

  it('GET returns null before detection and the record after; re-detect upserts one row', async () => {
    const { app } = appWith();
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId, 'Short body.');
    const a = await app;

    const before = await a.inject({ method: 'GET', url: `/pulls/${pr.id}/intent` });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toBeNull();

    await a.inject({ method: 'POST', url: `/pulls/${pr.id}/intent/detect` });
    await a.inject({ method: 'POST', url: `/pulls/${pr.id}/intent/detect` });

    expect((await a.inject({ method: 'GET', url: `/pulls/${pr.id}/intent` })).json().intent).toBe(
      INTENT_FIXTURE.intent,
    );
    const rows = await pg.handle.db
      .select()
      .from(t.prIntent)
      .where(eq(t.prIntent.prId, pr.id));
    expect(rows).toHaveLength(1);

    await a.close();
  });

  it('a review run makes TWO distinct LLM calls and records both in the trace', async () => {
    const { app, intentLlm, reviewLlm } = appWith();
    const a = await app;
    const { pr } = await setupRepoAndPr(
      pg.handle.db,
      workspaceId,
      'Add rate limiting to every public endpoint so unauthenticated clients cannot abuse ' +
        'the API. Returns 429 with a Retry-After header.',
    );

    const agent = (
      await a.inject({
        method: 'POST',
        url: '/agents',
        payload: {
          name: 'Intent Reviewer',
          provider: 'openai',
          model: 'gpt-4.1',
          system_prompt: 'You are a reviewer.',
        },
      })
    ).json();

    const res = await a.inject({
      method: 'POST',
      url: `/pulls/${pr.id}/review`,
      payload: { agentId: agent.id },
    });
    expect(res.statusCode).toBe(200);
    await waitForPrRuns(pg.handle.db, pr.id, { expected: 1 });

    // Two providers, one call each — the cheap classifier and the review model.
    expect(intentLlm.calls.filter((c) => c.method === 'completeStructured')).toHaveLength(1);
    expect(reviewLlm.calls.filter((c) => c.method === 'completeStructured')).toHaveLength(1);

    const runId = res.json().runs[0].run_id;
    const trace = (await a.inject({ method: 'GET', url: `/runs/${runId}/trace` })).json();

    const tools = trace.tool_calls.map((c: { tool: string }) => c.tool);
    expect(tools).toContain('classify_intent');
    expect(tools).toContain('review_file');
    expect(tools[0]).toBe('classify_intent');

    // The classifier row names its model and carries no secret / diff body.
    const classify = trace.tool_calls[0];
    expect(classify.args).toBe('openrouter/deepseek/deepseek-v4-flash');
    expect(classify.meta).toContain('conf=');
    expect(JSON.stringify(trace.tool_calls)).not.toContain('sk_live_xxx');

    // The review prompt carried the intent, delimiter-wrapped.
    expect(trace.prompt_assembly.intent).toContain('<untrusted source="intent">');
    expect(trace.prompt_assembly.intent).toContain(INTENT_FIXTURE.intent);
    expect(trace.prompt_assembly.user).toContain('## Intent');

    // The CRITICAL security finding survived, out-of-scope untouched.
    const reviews = (await a.inject({ method: 'GET', url: `/pulls/${pr.id}/reviews` })).json();
    const findings = reviews[0].findings;
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('CRITICAL');
    expect(findings[0].out_of_scope).toBe(false);

    await a.close();
  });

  it('re-detects when the PR head moves, and reuses the row when it has not', async () => {
    const { app, intentLlm } = appWith();
    const a = await app;
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId, 'Add rate limiting.');

    const agent = (
      await a.inject({
        method: 'POST',
        url: '/agents',
        payload: {
          name: 'Freshness Reviewer',
          provider: 'openai',
          model: 'gpt-4.1',
          system_prompt: 'You are a reviewer.',
        },
      })
    ).json();
    const runReview = () =>
      a.inject({ method: 'POST', url: `/pulls/${pr.id}/review`, payload: { agentId: agent.id } });

    await runReview();
    await waitForPrRuns(pg.handle.db, pr.id, { expected: 1 });
    const afterFirst = intentLlm.calls.filter((c) => c.method === 'completeStructured').length;
    expect(afterFirst).toBe(1);

    // Same head → the stored row is fresh, so no second classifier call.
    await runReview();
    await waitForPrRuns(pg.handle.db, pr.id, { expected: 2 });
    expect(intentLlm.calls.filter((c) => c.method === 'completeStructured')).toHaveLength(1);

    // Head moves → stale → re-classified against the new sha.
    await pg.handle.db
      .update(t.pullRequests)
      .set({ headSha: 'ffff9999' })
      .where(eq(t.pullRequests.id, pr.id));
    await runReview();
    await waitForPrRuns(pg.handle.db, pr.id, { expected: 3 });

    expect(intentLlm.calls.filter((c) => c.method === 'completeStructured')).toHaveLength(2);
    const [row] = await pg.handle.db
      .select()
      .from(t.prIntent)
      .where(eq(t.prIntent.prId, pr.id));
    expect(row?.headSha).toBe('ffff9999');

    await a.close();
  });

  it('persists a demoted finding with its scope note and serves it back', async () => {
    // The interesting direction: out_of_scope=true must survive the round trip,
    // or the UI silently shows a demoted finding as an ordinary suggestion.
    const intentLlm = new MockLLMProvider('openai', {
      structured: {
        intent: 'Add rate limiting to the public API endpoints.',
        in_scope: ['rate limiting middleware'],
        out_of_scope: ['src/theme.css'],
        confidence: 0.9,
      },
    });
    const reviewLlm = new MockLLMProvider('openai', {
      structured: {
        verdict: 'comment',
        summary: 'One styling nit outside the stated scope.',
        score: 70,
        findings: [
          {
            id: 'f-style',
            severity: 'WARNING',
            category: 'style',
            title: 'Inconsistent indentation',
            file: 'src/theme.css',
            start_line: 2,
            end_line: 2,
            rationale: 'Mixed tabs and spaces.',
            confidence: 0.6,
            kind: 'finding',
          },
        ],
      } satisfies Review,
    });
    const a = await buildApp({
      config: config(),
      db: pg.handle.db,
      overrides: {
        embedder: new MockEmbedder(),
        github: new MockGitHubClient(),
        git: new MockGitClient({
          diff: `diff --git a/src/theme.css b/src/theme.css
--- a/src/theme.css
+++ b/src/theme.css
@@ -1,1 +1,2 @@
 body { color: red; }
+	.btn { color: blue; }`,
        }),
        llm: { openrouter: intentLlm as never, openai: reviewLlm as never },
      },
    });
    const { pr } = await setupRepoAndPr(
      pg.handle.db,
      workspaceId,
      // Long enough to clear MIN_BODY_CHARS — otherwise confidence lands `low`
      // and the scope filter correctly refuses to demote anything.
      'Add a token-bucket rate limiter to every public API endpoint so unauthenticated ' +
        'clients cannot abuse the service. Returns 429 with a Retry-After header. Styling ' +
        'and theming are explicitly not part of this change.',
    );

    const agent = (
      await a.inject({
        method: 'POST',
        url: '/agents',
        payload: {
          name: 'Scope Reviewer',
          provider: 'openai',
          model: 'gpt-4.1',
          system_prompt: 'You are a reviewer.',
        },
      })
    ).json();
    await a.inject({
      method: 'POST',
      url: `/pulls/${pr.id}/review`,
      payload: { agentId: agent.id },
    });
    await waitForPrRuns(pg.handle.db, pr.id, { expected: 1 });

    const findings = (
      await a.inject({ method: 'GET', url: `/pulls/${pr.id}/reviews` })
    ).json()[0].findings;

    // Demoted, tagged — and still present. Never deleted.
    expect(findings).toHaveLength(1);
    expect(findings[0].out_of_scope).toBe(true);
    expect(findings[0].severity).toBe('SUGGESTION');
    expect(findings[0].scope_note).toContain('WARNING→SUGGESTION');
    expect(findings[0].scope_note).toContain('src/theme.css');

    await a.close();
  });

  it('a classifier failure does not fail the review', async () => {
    const brokenIntent = new MockLLMProvider('openai', { structured: { nope: true } });
    const reviewLlm = new MockLLMProvider('openai', { structured: REVIEW_FIXTURE });
    const a = await buildApp({
      config: config(),
      db: pg.handle.db,
      overrides: {
        embedder: new MockEmbedder(),
        github: new MockGitHubClient(),
        git: new MockGitClient({ diff: DIFF }),
        llm: { openrouter: brokenIntent as never, openai: reviewLlm as never },
      },
    });
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId, 'Add rate limiting.');

    const agent = (
      await a.inject({
        method: 'POST',
        url: '/agents',
        payload: {
          name: 'Resilient Reviewer',
          provider: 'openai',
          model: 'gpt-4.1',
          system_prompt: 'You are a reviewer.',
        },
      })
    ).json();

    const res = await a.inject({
      method: 'POST',
      url: `/pulls/${pr.id}/review`,
      payload: { agentId: agent.id },
    });
    const runId = res.json().runs[0].run_id;
    const runs = await waitForPrRuns(pg.handle.db, pr.id, { expected: 1 });

    expect(runs[0]?.status).toBe('done');
    const trace = (await a.inject({ method: 'GET', url: `/runs/${runId}/trace` })).json();
    // No intent → no classify_intent row, and the prompt has no ## Intent section.
    expect(trace.tool_calls.map((c: { tool: string }) => c.tool)).not.toContain('classify_intent');
    expect(trace.prompt_assembly.intent).toBeNull();
    expect(trace.prompt_assembly.user).not.toContain('## Intent');
    expect(trace.log.some((l: { msg: string }) => l.msg.includes('intent: detection failed'))).toBe(
      true,
    );

    await a.close();
  });
});
