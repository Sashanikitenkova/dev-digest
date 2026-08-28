import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Review } from '@devdigest/shared';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { waitForPrRuns } from './helpers/runs.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import { MockEmbedder, MockGitClient, MockGitHubClient, MockLLMProvider } from '../src/adapters/mocks.js';
import * as t from '../src/db/schema.js';

/**
 * Project-context module (SPEC-01) — the RUN path, end to end against a real
 * Postgres. `ReviewRunExecutor.buildSpecDocs` reads attached documents via
 * `container.git.readFile` (the GitClient PORT, NOT raw fs — unlike
 * `ContextService.listDocuments`), so this suite uses `MockGitClient`'s
 * in-memory `files` map rather than a real clone directory.
 *
 * Every LLM provider the review path can reach is injected — the intent
 * classifier resolves `openrouter`, MockLLMProvider only constructs as
 * 'openai'/'anthropic', so the openai-flavoured mock is injected under the
 * `openrouter` CONTAINER KEY (per server/INSIGHTS.md, 2026-08-22 and
 * 2026-08-11) — an un-injected provider silently hits the real network.
 */

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const config = () => loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);

const INTENT_FIXTURE = {
  intent: 'Add rate limiting to the public API endpoints.',
  in_scope: ['Add rate limiting middleware'],
  out_of_scope: [],
  confidence: 0.9,
};

const REVIEW_FIXTURE: Review = {
  verdict: 'comment',
  summary: 'Looks fine.',
  score: 90,
  findings: [],
};

const DIFF = `diff --git a/src/config.ts b/src/config.ts
--- a/src/config.ts
+++ b/src/config.ts
@@ -10,3 +10,4 @@
   port: 3000,
+  stripeKey: "sk_live_xxx",
   redisUrl: x,`;

let repoSeq = 0;

d('Project-context assembly on the run path (Testcontainers pg)', () => {
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

  function appWith(opts: { files?: Record<string, string>; diff?: string } = {}) {
    const intentLlm = new MockLLMProvider('openai', { structured: INTENT_FIXTURE });
    const reviewLlm = new MockLLMProvider('openai', { structured: REVIEW_FIXTURE });
    const app = buildApp({
      config: config(),
      db: pg.handle.db,
      overrides: {
        embedder: new MockEmbedder(),
        github: new MockGitHubClient(),
        git: new MockGitClient({ diff: opts.diff ?? DIFF, files: opts.files ?? {} }),
        llm: {
          // review_intent's registry default provider — see the mock-by-KEY note.
          openrouter: intentLlm as never,
          openai: reviewLlm as never,
        },
      },
    });
    return { app, intentLlm, reviewLlm };
  }

  async function setupRepoAndPr(body: string | null) {
    const name = `context-run-${repoSeq++}`;
    const [repo] = await pg.handle.db
      .insert(t.repos)
      .values({ workspaceId, owner: 'acme', name, fullName: `acme/${name}` })
      .returning();
    const [pr] = await pg.handle.db
      .insert(t.pullRequests)
      .values({
        workspaceId,
        repoId: repo!.id,
        number: 900 + repoSeq,
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
    await pg.handle.db.insert(t.prFiles).values({
      prId: pr!.id,
      path: 'src/config.ts',
      additions: 1,
      deletions: 0,
      patch: '@@ -10,3 +10,4 @@\n   port: 3000,\n+  stripeKey: "sk_live_xxx",\n   redisUrl: x,',
    });
    return { repo: repo!, pr: pr! };
  }

  async function createAgent(a: import('fastify').FastifyInstance, name: string) {
    const res = await a.inject({
      method: 'POST',
      url: '/agents',
      payload: { name, provider: 'openai', model: 'gpt-4.1', system_prompt: 'You are a reviewer.' },
    });
    return res.json();
  }

  async function runAndGetTrace(a: import('fastify').FastifyInstance, prId: string, agentId: string) {
    const res = await a.inject({ method: 'POST', url: `/pulls/${prId}/review`, payload: { agentId } });
    expect(res.statusCode).toBe(200);
    const runId = res.json().runs[0].run_id;
    const runs = await waitForPrRuns(pg.handle.db, prId, { expected: 1 });
    const trace = (await a.inject({ method: 'GET', url: `/runs/${runId}/trace` })).json();
    return { runs, trace, runId };
  }

  it('the assembled prompt carries ### <path> for an attached document', async () => {
    const { app } = appWith({
      files: { 'docs/architecture.md': '# Architecture\nThe api/ module must not import db/ directly.' },
    });
    const a = await app;
    const { pr } = await setupRepoAndPr('Add rate limiting.');
    const agent = await createAgent(a, 'Context Prompt Agent');
    await a.inject({
      method: 'PUT',
      url: `/agents/${agent.id}/context`,
      payload: { paths: ['docs/architecture.md'] },
    });

    const { trace } = await runAndGetTrace(a, pr.id, agent.id);

    expect(trace.prompt_assembly.specs).toContain('### docs/architecture.md');
    expect(trace.prompt_assembly.specs).toContain('<untrusted source="spec:docs/architecture.md">');
    expect(trace.prompt_assembly.specs).toContain('The api/ module must not import db/ directly.');
    expect(trace.prompt_assembly.user).toContain('## Project context');

    await a.close();
  });

  it('specs_read is derived from the ledger — only USED paths, never a literal', async () => {
    const { app } = appWith({
      files: { 'docs/present.md': '# Present document' },
      // 'docs/absent.md' is attached but deliberately absent from `files`.
    });
    const a = await app;
    const { pr } = await setupRepoAndPr('Add rate limiting.');
    const agent = await createAgent(a, 'Ledger Agent');
    await a.inject({
      method: 'PUT',
      url: `/agents/${agent.id}/context`,
      payload: { paths: ['docs/present.md', 'docs/absent.md'] },
    });

    const { trace } = await runAndGetTrace(a, pr.id, agent.id);

    expect(trace.specs_read).toEqual(['docs/present.md']);
    const detail = Object.fromEntries(
      (trace.specs_detail as { path: string; status: string }[]).map((e) => [e.path, e.status]),
    );
    expect(detail['docs/present.md']).toBe('used');
    expect(detail['docs/absent.md']).toBe('missing');
    expect(trace.specs_tokens).toBeGreaterThan(0);

    await a.close();
  });

  it('a run with no attachments at all has an EMPTY specs_read (regression: it was hardcoded to [])', async () => {
    const { app } = appWith();
    const a = await app;
    const { pr } = await setupRepoAndPr('Add rate limiting.');
    const agent = await createAgent(a, 'No Attachments Agent');

    const { trace } = await runAndGetTrace(a, pr.id, agent.id);

    expect(trace.specs_read).toEqual([]);
    expect(trace.prompt_assembly.specs).toBeNull();
    expect(trace.prompt_assembly.user).not.toContain('## Project context');

    await a.close();
  });

  it('a document deleted from the clone is reported missing in specs_detail and the run still completes (EC-3)', async () => {
    const { app } = appWith({ files: {} }); // 'docs/vanished.md' was never in the clone
    const a = await app;
    const { pr } = await setupRepoAndPr('Add rate limiting.');
    const agent = await createAgent(a, 'Vanished Doc Agent');
    await a.inject({
      method: 'PUT',
      url: `/agents/${agent.id}/context`,
      payload: { paths: ['docs/vanished.md'] },
    });

    const { runs, trace } = await runAndGetTrace(a, pr.id, agent.id);

    // The run completed normally — a missing document never fails a review.
    expect(runs[0]?.status).toBe('done');
    const vanished = (trace.specs_detail as { path: string; status: string; reason: string | null }[]).find(
      (e) => e.path === 'docs/vanished.md',
    );
    expect(vanished?.status).toBe('missing');
    expect(vanished?.reason).toBeTruthy();
    expect(trace.specs_read).not.toContain('docs/vanished.md');

    await a.close();
  });

  it('a disabled skill link contributes NO documents (AC-14 / EC-14)', async () => {
    const { app } = appWith({
      files: { 'docs/skill-doc.md': '# Should never be injected — the skill is disabled' },
    });
    const a = await app;
    const { pr } = await setupRepoAndPr('Add rate limiting.');
    const agent = await createAgent(a, 'Disabled Skill Agent');

    // source: 'manual' is required for the client-requested `enabled` flag to
    // actually take effect (see client/INSIGHTS.md, 2026-07-20).
    const skill = (
      await a.inject({
        method: 'POST',
        url: '/skills',
        payload: {
          name: 'disabled-context-skill',
          type: 'custom',
          source: 'manual',
          body: '# rule',
          enabled: false,
        },
      })
    ).json();
    expect(skill.enabled).toBe(false);

    await a.inject({
      method: 'PUT',
      url: `/skills/${skill.id}/context`,
      payload: { paths: ['docs/skill-doc.md'] },
    });
    await a.inject({
      method: 'POST',
      url: `/agents/${agent.id}/skills`,
      payload: { skill_ids: [skill.id] },
    });

    const { trace } = await runAndGetTrace(a, pr.id, agent.id);

    expect(trace.specs_read).toEqual([]);
    expect(trace.specs_detail ?? []).toEqual([]);
    expect(trace.prompt_assembly.specs).toBeNull();

    await a.close();
  });

  it('reads the clone\'s default-branch content, not anything derived from the PR diff (AC-16)', async () => {
    // The diff patches src/config.ts; the attached document is a DIFFERENT
    // path whose in-memory "clone" content is fixed. There is no code path by
    // which the diff could influence what gets read — this pins that the
    // content served is exactly the (fake) synced-checkout content.
    const { app } = appWith({
      files: { 'docs/rules.md': '# Committed rule\nNever hardcode a secret.' },
    });
    const a = await app;
    const { pr } = await setupRepoAndPr('Add rate limiting.');
    const agent = await createAgent(a, 'Default Branch Agent');
    await a.inject({
      method: 'PUT',
      url: `/agents/${agent.id}/context`,
      payload: { paths: ['docs/rules.md'] },
    });

    const { trace } = await runAndGetTrace(a, pr.id, agent.id);

    expect(trace.prompt_assembly.specs).toContain('Committed rule');
    expect(trace.prompt_assembly.specs).not.toContain('sk_live_xxx'); // from the diff, never the doc

    await a.close();
  });

  it('assembling the block makes ZERO model calls — attaching more documents does not add LLM calls (AC-22)', async () => {
    const { app, intentLlm, reviewLlm } = appWith({
      files: {
        'docs/one.md': '# One',
        'docs/two.md': '# Two',
        'docs/three.md': '# Three',
      },
    });
    const a = await app;
    const { pr } = await setupRepoAndPr('Add rate limiting.');
    const agent = await createAgent(a, 'No Extra Calls Agent');
    await a.inject({
      method: 'PUT',
      url: `/agents/${agent.id}/context`,
      payload: { paths: ['docs/one.md', 'docs/two.md', 'docs/three.md'] },
    });

    await runAndGetTrace(a, pr.id, agent.id);

    // Exactly one classifier call and one review call — three attached
    // documents did not add a third.
    expect(intentLlm.calls.filter((c) => c.method === 'completeStructured')).toHaveLength(1);
    expect(reviewLlm.calls.filter((c) => c.method === 'completeStructured')).toHaveLength(1);
    expect(intentLlm.calls).toHaveLength(1);
    expect(reviewLlm.calls).toHaveLength(1);

    await a.close();
  });
});
