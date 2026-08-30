import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and, isNull } from 'drizzle-orm';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import { MockLLMProvider, MockEmbedder, MockGitClient } from '../src/adapters/mocks.js';
import * as t from '../src/db/schema.js';
import type { EvalBatchDetail, EvalCase, EvalCompare, Review } from '@devdigest/shared';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const config = () => loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);

/**
 * One Review fixture answers every case, because a case's diff is the only
 * input that varies. It cites `src/config.ts:11`, which exists only in the two
 * config.ts cases — so the same model output is a hit there and an ungrounded
 * citation everywhere else. That asymmetry is deliberate: it exercises the
 * grounding gate and gives citation_accuracy something real to measure.
 */
const REVIEW_FIXTURE: Review = {
  verdict: 'request_changes',
  summary: 'Hardcoded Stripe secret introduced.',
  score: 42,
  findings: [
    {
      id: 'f-stripe',
      severity: 'CRITICAL',
      category: 'security',
      title: 'Hardcoded Stripe secret key',
      file: 'src/config.ts',
      start_line: 11,
      end_line: 11,
      rationale: 'A live Stripe key is committed in source.',
      suggestion: 'Move the key to an environment variable.',
      confidence: 0.95,
      kind: 'finding',
    },
  ],
};

d('SPEC-03 eval pipeline (Testcontainers pg)', () => {
  let pg: PgFixture;
  let workspaceId: string;
  let agentId: string;
  let llm: MockLLMProvider;

  /**
   * Every provider a path can reach must be injected. `overrides.llm` is a
   * partial record, so an omitted provider silently falls through to
   * `~/.devdigest/secrets.json` — on a machine that has a key, the test would
   * quietly make real billed calls and only look slow (server/INSIGHTS.md).
   * `MockLLMProvider` has no 'openrouter' id, so the openai-flavoured mock is
   * injected UNDER that key: `Container.llm(id)` resolves by key, never by
   * `provider.id`.
   */
  function app() {
    return buildApp({
      config: config(),
      db: pg.handle.db,
      overrides: {
        embedder: new MockEmbedder(),
        git: new MockGitClient({ diff: '' }),
        llm: {
          openai: llm as never,
          anthropic: llm as never,
          openrouter: llm as never,
        },
      },
    });
  }

  /** Poll the batch until it leaves `running` — execution is fire-and-forget. */
  async function waitForBatch(a: Awaited<ReturnType<typeof app>>, batchId: string, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await a.inject({ method: 'GET', url: `/eval/runs/${batchId}` });
      const body = res.json() as EvalBatchDetail;
      if (body.batch.status !== 'running') return body;
      if (Date.now() > deadline) throw new Error(`batch ${batchId} still running after ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  const findingByTitle = async (title: string) => {
    const [row] = await pg.handle.db.select().from(t.findings).where(eq(t.findings.title, title));
    return row!;
  };

  beforeAll(async () => {
    pg = await startPg();
    await seed(pg.handle.db);
    const [ws] = await pg.handle.db.select().from(t.workspaces);
    workspaceId = ws!.id;
    const [agent] = await pg.handle.db
      .select()
      .from(t.agents)
      .where(and(eq(t.agents.workspaceId, workspaceId), eq(t.agents.name, 'Security Reviewer')));
    agentId = agent!.id;
    llm = new MockLLMProvider('openai', { structured: REVIEW_FIXTURE });
  });
  afterAll(async () => {
    await pg?.stop();
  });

  // ---- case creation ------------------------------------------------------

  it('turns an accepted finding into a must_find case owned by the review agent', async () => {
    const a = await app();
    const finding = await findingByTitle('Hardcoded Stripe secret key in commit');
    const res = await a.inject({ method: 'POST', url: `/findings/${finding.id}/eval-case` });
    expect(res.statusCode).toBe(201);

    const body = res.json() as EvalCase;
    expect(body.owner_id).toBe(agentId);
    expect(body.source_finding_id).toBe(finding.id);
    expect(body.expected_output).toMatchObject({
      kind: 'must_find',
      targets: [{ file: 'src/config.ts', start_line: 11 }],
    });
    // The frozen input is the finding's file only, not the whole PR.
    expect(body.input_diff).toContain('src/config.ts');
    expect(body.input_diff).not.toContain('src/api/users.ts');
    await a.close();
  });

  it('turns a dismissed finding into a must_not_flag case', async () => {
    const a = await app();
    const finding = await findingByTitle('Magic number for the rate-limit ceiling');
    const res = await a.inject({ method: 'POST', url: `/findings/${finding.id}/eval-case` });
    expect(res.statusCode).toBe(201);
    expect((res.json() as EvalCase).expected_output).toMatchObject({ kind: 'must_not_flag' });
    await a.close();
  });

  it('is idempotent — a second click returns the same case, not a duplicate', async () => {
    const a = await app();
    const finding = await findingByTitle('N+1 query in user list endpoint');
    const first = await a.inject({ method: 'POST', url: `/findings/${finding.id}/eval-case` });
    const second = await a.inject({ method: 'POST', url: `/findings/${finding.id}/eval-case` });
    expect((second.json() as EvalCase).id).toBe((first.json() as EvalCase).id);

    const rows = await pg.handle.db
      .select()
      .from(t.evalCases)
      .where(eq(t.evalCases.sourceFindingId, finding.id));
    expect(rows).toHaveLength(1);
    await a.close();
  });

  it('refuses a finding with no accept/dismiss decision', async () => {
    const a = await app();
    const [review] = await pg.handle.db
      .select()
      .from(t.reviews)
      .where(eq(t.reviews.model, 'seed'));
    const [undecided] = await pg.handle.db
      .insert(t.findings)
      .values({
        reviewId: review!.id,
        file: 'src/config.ts',
        startLine: 11,
        endLine: 11,
        severity: 'WARNING',
        category: 'bug',
        title: 'Undecided finding',
        rationale: 'Nobody judged this yet.',
        confidence: 0.5,
      })
      .returning();

    const res = await a.inject({ method: 'POST', url: `/findings/${undecided!.id}/eval-case` });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toMatch(/accept or dismiss/i);
    await pg.handle.db.delete(t.findings).where(eq(t.findings.id, undecided!.id));
    await a.close();
  });

  it('refuses a finding whose review has no agent', async () => {
    const a = await app();
    const [pr] = await pg.handle.db.select().from(t.pullRequests);
    const [orphanReview] = await pg.handle.db
      .insert(t.reviews)
      .values({ workspaceId, prId: pr!.id, kind: 'review', model: 'orphan' })
      .returning();
    const [orphan] = await pg.handle.db
      .insert(t.findings)
      .values({
        reviewId: orphanReview!.id,
        file: 'src/config.ts',
        startLine: 11,
        endLine: 11,
        severity: 'CRITICAL',
        category: 'security',
        title: 'Orphan finding',
        rationale: 'Its review has no agent.',
        confidence: 0.9,
        acceptedAt: new Date(),
      })
      .returning();

    const res = await a.inject({ method: 'POST', url: `/findings/${orphan!.id}/eval-case` });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toMatch(/no agent/i);
    await pg.handle.db.delete(t.reviews).where(eq(t.reviews.id, orphanReview!.id));
    await a.close();
  });

  // ---- running a batch ----------------------------------------------------

  it('runs every case, scores in code, and never touches agent_runs', async () => {
    const a = await app();

    // Build the full set by clicking through every decided finding, exactly the
    // way the user does — 10 seeded decisions, comfortably over the 8 required.
    const decided = await pg.handle.db
      .select()
      .from(t.findings)
      .where(eq(t.findings.reviewId, (await findingByTitle('Hardcoded Stripe secret key in commit')).reviewId));
    for (const f of decided) {
      if (!f.acceptedAt && !f.dismissedAt) continue;
      await a.inject({ method: 'POST', url: `/findings/${f.id}/eval-case` });
    }

    const cases = (await a.inject({ method: 'GET', url: `/eval/cases?owner_id=${agentId}` })).json();
    expect(cases.cases.length).toBeGreaterThanOrEqual(8);

    const agentRunsBefore = await pg.handle.db.select().from(t.agentRuns);
    llm.calls.length = 0;

    const start = await a.inject({ method: 'POST', url: `/agents/${agentId}/eval-runs` });
    expect(start.statusCode).toBe(202);
    const { batch_id, cases_total } = start.json();
    expect(cases_total).toBe(cases.cases.length);

    const detail = await waitForBatch(a, batch_id);
    expect(detail.batch.status).toBe('done');
    expect(detail.runs).toHaveLength(cases_total);

    // EXACTLY one model call per case: scoring adds none (SPEC-03 AC-20, AC-26).
    const structuredCalls = llm.calls.filter((c) => c.method === 'completeStructured');
    expect(structuredCalls).toHaveLength(cases_total);

    // The batch is invisible to the real-review observability table (AC-25).
    const agentRunsAfter = await pg.handle.db.select().from(t.agentRuns);
    expect(agentRunsAfter).toHaveLength(agentRunsBefore.length);

    // The snapshot is what makes a later comparison meaningful (AC-38).
    expect(detail.batch.system_prompt.length).toBeGreaterThan(0);
    expect(detail.batch.agent_version).toBeGreaterThanOrEqual(1);

    // Deterministic metrics: the fixture cites src/config.ts:11, which grounds
    // only in the two config.ts cases and is dropped in every other one.
    const configCases = detail.runs.filter((r) => (r.kept ?? 0) > 0);
    expect(configCases).toHaveLength(2);
    expect(detail.batch.citation_accuracy).toBeCloseTo(2 / (2 + 8));
    // One must_find hit, and every must_not_flag case stays quiet.
    expect(detail.batch.traces_passed).toBe(5);
    expect(detail.batch.traces_total).toBe(10);
    expect(detail.batch.recall).toBeCloseTo(1 / 6);
    expect(detail.batch.precision).toBe(1);

    // The raw counters are persisted so the aggregate can be audited (AC-36).
    const summed = detail.runs.reduce((n, r) => n + (r.tp ?? 0), 0);
    expect(summed).toBe(1);
    // Dropped citations are kept WITH their reason, not merely counted (AC-37).
    const droppedRun = detail.runs.find((r) => (r.dropped ?? 0) > 0)!;
    expect((droppedRun.actual_output as { dropped: { reason: string }[] }).dropped[0]!.reason)
      .toMatch(/not present in diff|do not intersect/);
    await a.close();
  });

  it('refuses to start a batch for an agent with no cases', async () => {
    const a = await app();
    const [other] = await pg.handle.db
      .select()
      .from(t.agents)
      .where(and(eq(t.agents.workspaceId, workspaceId), eq(t.agents.name, 'General Reviewer')));
    const res = await a.inject({ method: 'POST', url: `/agents/${other!.id}/eval-runs` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/no eval cases/i);
    await a.close();
  });

  // ---- comparing two batches ---------------------------------------------

  it('compares two runs and flags a case set that changed between them', async () => {
    const a = await app();

    const first = (await a.inject({ method: 'POST', url: `/agents/${agentId}/eval-runs` })).json();
    await waitForBatch(a, first.batch_id);

    // Same set, changed prompt: the comparison is valid.
    await a.inject({
      method: 'PUT',
      url: `/agents/${agentId}`,
      payload: { system_prompt: 'You are a security reviewer. Cite file and line for every finding.' },
    });
    const second = (await a.inject({ method: 'POST', url: `/agents/${agentId}/eval-runs` })).json();
    await waitForBatch(a, second.batch_id);

    const same = (
      await a.inject({ method: 'GET', url: `/eval/compare?a=${first.batch_id}&b=${second.batch_id}` })
    ).json() as EvalCompare;
    expect(same.case_set_mismatch).toBe(false);
    expect(same.skills_changed).toBe(false);
    // Both snapshots come back, so the UI can diff the prompts that produced them.
    expect(same.a.system_prompt).not.toBe(same.b.system_prompt);
    expect(same.b.system_prompt).toMatch(/Cite file and line/);
    expect(same.delta.recall).toBeCloseTo(0);

    // Now grow the set and re-run: the delta is no longer attributable.
    await a.inject({
      method: 'POST',
      url: '/eval/cases',
      payload: {
        owner_id: agentId,
        name: 'extra-case',
        input_diff: '@@ -1,1 +1,2 @@\n a\n+b',
        expected_output: {
          kind: 'must_not_flag',
          targets: [{ file: 'src/nowhere.ts', start_line: 1, end_line: 1 }],
        },
      },
    });
    const third = (await a.inject({ method: 'POST', url: `/agents/${agentId}/eval-runs` })).json();
    await waitForBatch(a, third.batch_id);

    const drifted = (
      await a.inject({ method: 'GET', url: `/eval/compare?a=${second.batch_id}&b=${third.batch_id}` })
    ).json() as EvalCompare;
    expect(drifted.case_set_mismatch).toBe(true);
    await a.close();
  });

  it('rejects an expectation with no targets rather than storing half of it', async () => {
    const a = await app();
    const res = await a.inject({
      method: 'POST',
      url: '/eval/cases',
      payload: {
        owner_id: agentId,
        name: 'bad-case',
        input_diff: '@@ -1,1 +1,2 @@\n a\n+b',
        expected_output: { kind: 'must_find', targets: [] },
      },
    });
    // 422 from the route schema, not 400 from the service: routes validate
    // before the handler runs, so a targetless expectation never reaches it.
    expect(res.statusCode).toBe(422);
    const rows = await pg.handle.db
      .select()
      .from(t.evalCases)
      .where(eq(t.evalCases.name, 'bad-case'));
    expect(rows).toHaveLength(0);
    await a.close();
  });

  it('keeps a case when its source finding is deleted', async () => {
    const a = await app();
    const finding = await findingByTitle('Missing await on logger.warn');
    const created = (
      await a.inject({ method: 'POST', url: `/findings/${finding.id}/eval-case` })
    ).json() as EvalCase;

    await pg.handle.db.delete(t.findings).where(eq(t.findings.id, finding.id));

    const [row] = await pg.handle.db
      .select()
      .from(t.evalCases)
      .where(eq(t.evalCases.id, created.id));
    // Frozen fixture survives; only the provenance link is nulled (AC-12).
    expect(row).toBeDefined();
    expect(row!.sourceFindingId).toBeNull();
    const orphaned = await pg.handle.db
      .select()
      .from(t.evalCases)
      .where(isNull(t.evalCases.sourceFindingId));
    expect(orphaned.length).toBeGreaterThan(0);
    await a.close();
  });
});
