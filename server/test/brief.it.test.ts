/* Why + Risk brief, end to end against a real Postgres.

   The assertions a unit test cannot make:
     • the same PR state is served from cache with ZERO further model calls
     • a new head SHA generates again; regenerate always generates
     • the model receives structured context and NO diff hunk bodies
     • an invented reference is dropped before the brief is ever stored
     • the whole model input stays inside the 8,000-token budget

   Both `openai` and `openrouter` slots are injected on purpose: ContainerOverrides
   .llm is a PARTIAL record, so an un-injected provider silently makes real,
   billed network calls, and the tell is runtime (seconds, not a red assertion). */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
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
import { BRIEF_TOKEN_BUDGET } from '../src/modules/brief/constants.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const config = () => loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);

/** The added line here must never appear in a prompt. */
const SECRET = 'sk_live_51H8xq2Ka9Vn3PqLm7Rd0bZ4Xc';
const DIFF = `diff --git a/src/config.ts b/src/config.ts
--- a/src/config.ts
+++ b/src/config.ts
@@ -10,3 +10,4 @@
   port: 3000,
+  stripeKey: "${SECRET}",
   redisUrl: x,`;

/** One valid reference, one invented file, one invented endpoint. */
const BRIEF_FIXTURE = {
  what: 'Adds a token-bucket rate limiter to the public API routes.',
  why: 'Unauthenticated clients were able to abuse the public endpoints.',
  risk_level: 'high' as const,
  risks: [
    {
      severity: 'high' as const,
      summary: 'A live Stripe key is committed in plaintext.',
      reference: { file: 'src/config.ts', line: 11 },
    },
    {
      severity: 'medium' as const,
      summary: 'Invented file that the repo does not contain.',
      reference: { file: 'src/totally/invented.ts', line: 3 },
    },
  ],
  review_focus: [
    {
      summary: 'Check the limiter returns the promised Retry-After header.',
      reference: { file: 'src/config.ts', line: 11 },
    },
    {
      summary: 'Endpoint the blast map never reported.',
      reference: { endpoint: 'DELETE /api/public/nope' },
    },
  ],
};

/** A promise the test releases by hand, so two requests can overlap on purpose. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Wrap a mock provider so `completeStructured` parks on `gate` before answering.
 *
 * The wrapper delegates to the SAME instance the test asserts on, so `llm.calls`
 * still counts every call — a second provider object would make the one-call
 * assertions vacuous.
 */
function holdStructured(llm: MockLLMProvider, gate: Promise<void>) {
  const entry = deferred();
  const proxy = new Proxy(llm, {
    get(target, prop, receiver) {
      if (prop === 'completeStructured') {
        return async (req: unknown) => {
          entry.resolve();
          await gate;
          return (target.completeStructured as (r: unknown) => unknown)(req);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  // `entered` is what makes these tests deterministic. A fixed number of ticks
  // is not enough: a generation does a dozen awaits (context, pull, diff,
  // intent, blast, risks) before it reaches the model, so a test that races it
  // with setImmediate silently tests the wrong interleaving.
  return { provider: proxy, entered: entry.promise };
}

let repoSeq = 0;
async function setupRepoAndPr(db: PgFixture['handle']['db'], workspaceId: string) {
  const name = `brief-api-${repoSeq++}`;
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
      headSha: 'head-one',
      additions: 1,
      deletions: 0,
      filesCount: 1,
      status: 'needs_review',
      body: 'Rate limit the public endpoints. Closes #471.',
    })
    .returning();
  await db.insert(t.prFiles).values({
    prId: pr!.id,
    path: 'src/config.ts',
    additions: 1,
    deletions: 0,
    patch: `@@ -10,3 +10,4 @@\n   port: 3000,\n+  stripeKey: "${SECRET}",\n   redisUrl: x,`,
  });
  return { repo: repo!, pr: pr! };
}

d('Why + Risk brief (Testcontainers pg)', () => {
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

  function appWith() {
    // risk_brief resolves to openrouter; the openai slot is injected too so an
    // un-injected provider can never reach the network.
    const llm = new MockLLMProvider('openai', { structured: BRIEF_FIXTURE });
    const app = buildApp({
      config: config(),
      db: pg.handle.db,
      overrides: {
        embedder: new MockEmbedder(),
        github: new MockGitHubClient(),
        git: new MockGitClient({ diff: DIFF }),
        llm: { openrouter: llm as never, openai: llm as never },
      },
    });
    return { app, llm };
  }

  const structuredCalls = (llm: MockLLMProvider) =>
    llm.calls.filter((c) => c.method === 'completeStructured');

  it('POST generates a valid brief with full provenance (AC-4, AC-6, AC-7)', async () => {
    const { app, llm } = appWith();
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);

    const res = await (await app).inject({ method: 'POST', url: `/pulls/${pr.id}/brief` });
    expect(res.statusCode).toBe(200);
    const brief = res.json();

    expect(brief.what).toBe(BRIEF_FIXTURE.what);
    expect(brief.why).toBe(BRIEF_FIXTURE.why);
    expect(brief.risk_level).toBe('high');
    expect(Array.isArray(brief.risks)).toBe(true);
    expect(Array.isArray(brief.review_focus)).toBe(true);

    // Provenance travels on the RESPONSE, not only the row.
    expect(brief.head_sha).toBe('head-one');
    expect(brief.provider).toBe('openrouter');
    expect(brief.model).toBe('deepseek/deepseek-v4-pro'); // the registry default
    expect(brief.generated_at).toBeTruthy();

    const [row] = await pg.handle.db
      .select()
      .from(t.prBrief)
      .where(eq(t.prBrief.prId, pr.id));
    expect(row?.headSha).toBe('head-one');
    expect(structuredCalls(llm)).toHaveLength(1);
  });

  it('sends structured PR context and NO diff hunk bodies (AC-9, AC-11)', async () => {
    const { app, llm } = appWith();
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);
    await (await app).inject({ method: 'POST', url: `/pulls/${pr.id}/brief` });

    const sent = JSON.stringify(structuredCalls(llm)[0]!.req);
    // Structured metadata is present…
    expect(sent).toContain('Add rate limiting to public API endpoints');
    expect(sent).toContain('marisa.koch');
    expect(sent).toContain('src/config.ts');
    expect(sent).toContain('@@ -10,3 +10,4 @@'); // hunk COORDINATES
    // …and the hunk body is not.
    expect(sent).not.toContain(SECRET);
    expect(sent).not.toContain('port: 3000');
  });

  it('keeps the complete model input inside the token budget (AC-13)', async () => {
    const { app, llm } = appWith();
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);
    await (await app).inject({ method: 'POST', url: `/pulls/${pr.id}/brief` });

    const { TiktokenTokenizer } = await import('../src/adapters/tokenizer/index.js');
    const { briefSchemaJson } = await import('../src/modules/brief/budget.js');
    const tok = new TiktokenTokenizer();
    const req = structuredCalls(llm)[0]!.req as { messages: { content: string }[] };
    // Reconstruct exactly what the provider serializes: both messages + schema.
    const total =
      req.messages.reduce((n, m) => n + tok.count(m.content), 0) +
      tok.count(briefSchemaJson());
    expect(total).toBeLessThanOrEqual(BRIEF_TOKEN_BUDGET);
  });

  it('drops references the input never contained (AC-25, AC-27, AC-28)', async () => {
    const { app } = appWith();
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);
    const res = await (await app).inject({ method: 'POST', url: `/pulls/${pr.id}/brief` });
    const brief = res.json();

    const files = brief.risks.map((r: { reference: { file?: string } }) => r.reference.file);
    expect(files).not.toContain('src/totally/invented.ts');
    const endpoints = brief.review_focus.map(
      (f: { reference: { endpoint?: string } }) => f.reference.endpoint,
    );
    expect(endpoints).not.toContain('DELETE /api/public/nope');

    // Proposed vs kept is recorded, so "invented everything" cannot look clean.
    expect(brief.counts.risks_proposed).toBe(2);
    expect(brief.counts.risks_kept).toBe(1);
    expect(brief.counts.focus_proposed).toBe(2);
    expect(brief.counts.focus_kept).toBe(1);
  });

  it('serves the same PR state from cache with no further model call (AC-3)', async () => {
    const { app, llm } = appWith();
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);
    const built = await app;

    const first = await built.inject({ method: 'POST', url: `/pulls/${pr.id}/brief` });
    const second = await built.inject({ method: 'POST', url: `/pulls/${pr.id}/brief` });

    expect(second.statusCode).toBe(200);
    expect(second.json().generated_at).toBe(first.json().generated_at);
    // The whole point: reopening an unchanged PR spends nothing.
    expect(structuredCalls(llm)).toHaveLength(1);
  });

  it('GET never calls the model, with or without a stored brief (AC-2)', async () => {
    const { app, llm } = appWith();
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);
    const built = await app;

    const empty = await built.inject({ method: 'GET', url: `/pulls/${pr.id}/brief` });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toBeNull();
    expect(structuredCalls(llm)).toHaveLength(0);

    await built.inject({ method: 'POST', url: `/pulls/${pr.id}/brief` });
    const stored = await built.inject({ method: 'GET', url: `/pulls/${pr.id}/brief` });
    expect(stored.json().what).toBe(BRIEF_FIXTURE.what);
    expect(structuredCalls(llm)).toHaveLength(1); // still just the POST's
  });

  it('generates again when the PR moves to a new head (AC-4)', async () => {
    const { app, llm } = appWith();
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);
    const built = await app;

    await built.inject({ method: 'POST', url: `/pulls/${pr.id}/brief` });
    await pg.handle.db
      .update(t.pullRequests)
      .set({ headSha: 'head-two' })
      .where(eq(t.pullRequests.id, pr.id));

    const res = await built.inject({ method: 'POST', url: `/pulls/${pr.id}/brief` });
    expect(res.json().head_sha).toBe('head-two');
    expect(structuredCalls(llm)).toHaveLength(2);

    // Still exactly one row for the PR — a replace, not an append.
    const rows = await pg.handle.db.select().from(t.prBrief).where(eq(t.prBrief.prId, pr.id));
    expect(rows).toHaveLength(1);
  });

  it('regenerate always generates, even on an unchanged head (AC-5)', async () => {
    const { app, llm } = appWith();
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);
    const built = await app;

    await built.inject({ method: 'POST', url: `/pulls/${pr.id}/brief` });
    const res = await built.inject({
      method: 'POST',
      url: `/pulls/${pr.id}/brief/regenerate`,
    });

    expect(res.statusCode).toBe(200);
    expect(structuredCalls(llm)).toHaveLength(2);
    const rows = await pg.handle.db.select().from(t.prBrief).where(eq(t.prBrief.prId, pr.id));
    expect(rows).toHaveLength(1);
  });

  it('records an input ledger naming what was unavailable (AC-15, AC-33)', async () => {
    const { app } = appWith();
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);
    const res = await (await app).inject({ method: 'POST', url: `/pulls/${pr.id}/brief` });
    const inputs = res.json().inputs as { section: string; status: string; reason?: string }[];

    expect(Array.isArray(inputs)).toBe(true);
    expect(inputs.length).toBeGreaterThan(0);
    // No pr_intent row was ever written for this PR, and the brief must not
    // trigger detection to get one.
    const intent = inputs.find((i) => i.section.includes('intent'));
    expect(intent?.status).toBe('unavailable');
    expect(intent?.reason).toBeTruthy();
    const rows = await pg.handle.db.select().from(t.prIntent).where(eq(t.prIntent.prId, pr.id));
    expect(rows).toHaveLength(0);
  });

  it('leaves a stored brief untouched when the model fails, and the PR page still loads (AC-31, AC-37)', async () => {
    const { app } = appWith();
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);
    const built = await app;
    await built.inject({ method: 'POST', url: `/pulls/${pr.id}/brief` });
    const [before] = await pg.handle.db
      .select()
      .from(t.prBrief)
      .where(eq(t.prBrief.prId, pr.id));

    // A second app whose model throws.
    const failing = new MockLLMProvider('openai', { structured: BRIEF_FIXTURE });
    failing.completeStructured = async () => {
      throw new Error('upstream returned 503 with body {"err":"overloaded"}');
    };
    const failApp = await buildApp({
      config: config(),
      db: pg.handle.db,
      overrides: {
        embedder: new MockEmbedder(),
        github: new MockGitHubClient(),
        git: new MockGitClient({ diff: DIFF }),
        llm: { openrouter: failing as never, openai: failing as never },
      },
    });

    const res = await failApp.inject({
      method: 'POST',
      url: `/pulls/${pr.id}/brief/regenerate`,
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    // The provider's own response body must not reach the user.
    expect(res.body).not.toContain('overloaded');

    const [after] = await pg.handle.db
      .select()
      .from(t.prBrief)
      .where(eq(t.prBrief.prId, pr.id));
    expect(after?.generatedAt).toEqual(before?.generatedAt);

    // The rest of the Overview tab is unaffected.
    for (const path of ['intent', 'risks', 'blast']) {
      const other = await failApp.inject({ method: 'GET', url: `/pulls/${pr.id}/${path}` });
      expect(other.statusCode).toBe(200);
    }
  });

  it('names completion-budget exhaustion instead of blaming the provider', async () => {
    // The failure that shipped: a reasoning model spends the whole completion
    // cap reasoning, returns empty content, and the repair loop gives up. The
    // old message sent the reader to check provider reachability, which is the
    // one thing that was fine.
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);
    const capped = new MockLLMProvider('openai', { structured: BRIEF_FIXTURE });
    capped.completeStructured = async () => {
      throw new Error(
        'OpenRouter hit the completion cap for risk_brief before returning parseable output ' +
          '(finish_reason=length, content=empty, reasoning_tokens=1200, max_tokens=1200). ' +
          'Raise maxTokens: on a reasoning model the reasoning tokens come out of it too.',
      );
    };
    const app = await buildApp({
      config: config(),
      db: pg.handle.db,
      overrides: {
        embedder: new MockEmbedder(),
        github: new MockGitHubClient(),
        git: new MockGitClient({ diff: DIFF }),
        llm: { openrouter: capped as never, openai: capped as never },
      },
    });

    const res = await app.inject({ method: 'POST', url: `/pulls/${pr.id}/brief` });
    expect(res.statusCode).toBe(502);
    expect(res.body).toMatch(/completion budget/i);
    expect(res.body).not.toMatch(/provider is reachable/i);
    // AC-31 still holds: our diagnosis travels, the provider's body does not.
    expect(res.body).not.toContain('finish_reason=length');
  });

  it('still blames neither when the provider genuinely fails (AC-31)', async () => {
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);
    const broken = new MockLLMProvider('openai', { structured: BRIEF_FIXTURE });
    broken.completeStructured = async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.1:443');
    };
    const app = await buildApp({
      config: config(),
      db: pg.handle.db,
      overrides: {
        embedder: new MockEmbedder(),
        github: new MockGitHubClient(),
        git: new MockGitClient({ diff: DIFF }),
        llm: { openrouter: broken as never, openai: broken as never },
      },
    });

    const res = await app.inject({ method: 'POST', url: `/pulls/${pr.id}/brief` });
    expect(res.statusCode).toBe(502);
    // The generic branch, and no transport detail leaked.
    expect(res.body).toMatch(/provider is reachable/i);
    expect(res.body).not.toContain('ECONNREFUSED');
  });

  it('returns the token and cost provenance the contract promises (AC-7)', async () => {
    const { app } = appWith();
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);

    const brief = (await (await app).inject({ method: 'POST', url: `/pulls/${pr.id}/brief` })).json();

    // The three fields the type system was carrying alone. MockLLMProvider
    // reports 100/50/0.001, so a null here means the write or the mapper drops
    // them — which no other assertion in this suite would notice.
    expect(brief.tokens_in).toBe(100);
    expect(brief.tokens_out).toBe(50);
    expect(Number(brief.cost_usd)).toBeCloseTo(0.001);

    const [row] = await pg.handle.db.select().from(t.prBrief).where(eq(t.prBrief.prId, pr.id));
    expect(row?.tokensIn).toBe(100);
    expect(row?.tokensOut).toBe(50);
    expect(row?.costUsd).not.toBeNull();
  });

  it('errors the GET when the stored brief cannot be read, and generates nothing (AC-36)', async () => {
    const { app, llm } = appWith();
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);

    const { BriefRepository } = await import('../src/modules/brief/repository.js');
    const spy = vi
      .spyOn(BriefRepository.prototype, 'getByPr')
      .mockRejectedValue(new Error('pr_brief read failed'));
    try {
      const res = await (await app).inject({ method: 'GET', url: `/pulls/${pr.id}/brief` });
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
    } finally {
      spy.mockRestore();
    }

    // The point of the AC: a failed read is not evidence that a paid call is
    // wanted. No fallback generation, and no row conjured on the way past.
    expect(structuredCalls(llm)).toHaveLength(0);
    const rows = await pg.handle.db.select().from(t.prBrief).where(eq(t.prBrief.prId, pr.id));
    expect(rows).toHaveLength(0);
  });

  it('coalesces concurrent generations into one model call (AC-63, EC-19)', async () => {
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);
    const gate = deferred();
    const llm = new MockLLMProvider('openai', { structured: BRIEF_FIXTURE });
    const held = holdStructured(llm, gate.promise);
    const app = await buildApp({
      config: config(),
      db: pg.handle.db,
      overrides: {
        embedder: new MockEmbedder(),
        github: new MockGitHubClient(),
        git: new MockGitClient({ diff: DIFF }),
        llm: { openrouter: held.provider as never, openai: held.provider as never },
      },
    });

    // A must be registered in flight before B looks, and A must NOT be allowed
    // to settle until B has looked — otherwise B legitimately misses an entry
    // that is already gone, and the test fails for a reason that is not the
    // product. `getByPr` is B's last await before the single-flight check
    // (service.ts: getPullWithRepo → getByPr → isFreshBrief → inFlight.get),
    // so its second call is the safe moment to release A.
    const { BriefRepository } = await import('../src/modules/brief/repository.js');
    const bLooked = deferred();
    const realGetByPr = BriefRepository.prototype.getByPr;
    let reads = 0;
    const spy = vi
      .spyOn(BriefRepository.prototype, 'getByPr')
      .mockImplementation(async function (this: InstanceType<typeof BriefRepository>, prId: string) {
        const row = await realGetByPr.call(this, prId);
        if (++reads === 2) bLooked.resolve();
        return row;
      });

    try {
      const a = app.inject({ method: 'POST', url: `/pulls/${pr.id}/brief` });
      await held.entered;
      const b = app.inject({ method: 'POST', url: `/pulls/${pr.id}/brief` });
      await bLooked.promise;
      gate.resolve();
      var [first, second] = await Promise.all([a, b]);
    } finally {
      spy.mockRestore();
    }

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json().generated_at).toBe(second.json().generated_at);
    expect(structuredCalls(llm)).toHaveLength(1);
  });

  it('discards a generation whose head moved while it ran (AC-64, EC-20)', async () => {
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);
    const gate = deferred();
    const llm = new MockLLMProvider('openai', { structured: BRIEF_FIXTURE });
    const held = holdStructured(llm, gate.promise);
    const app = await buildApp({
      config: config(),
      db: pg.handle.db,
      overrides: {
        embedder: new MockEmbedder(),
        github: new MockGitHubClient(),
        git: new MockGitClient({ diff: DIFF }),
        llm: { openrouter: held.provider as never, openai: held.provider as never },
      },
    });

    const inFlight = app.inject({ method: 'POST', url: `/pulls/${pr.id}/brief` });
    await held.entered;
    // The PR moves underneath the running generation — after it has read
    // head-one, which is the only interleaving AC-64 is about.
    await pg.handle.db
      .update(t.pullRequests)
      .set({ headSha: 'head-two' })
      .where(eq(t.pullRequests.id, pr.id));
    gate.resolve();
    const res = await inFlight;

    // A result for head-one must not be stored against a PR now at head-two.
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatch(/moved to a new head/i);
    const rows = await pg.handle.db.select().from(t.prBrief).where(eq(t.prBrief.prId, pr.id));
    expect(rows).toHaveLength(0);
  });

  it('rate-limits both generation routes and neither GET (AC-58)', async () => {
    // The limiter is disabled under NODE_ENV=test, so this is the one test that
    // must build the app in development to observe it at all.
    const devConfig = loadConfig({
      ...process.env,
      NODE_ENV: 'development',
    } as NodeJS.ProcessEnv);
    const llm = new MockLLMProvider('openai', { structured: BRIEF_FIXTURE });
    const app = await buildApp({
      config: devConfig,
      db: pg.handle.db,
      overrides: {
        embedder: new MockEmbedder(),
        github: new MockGitHubClient(),
        git: new MockGitClient({ diff: DIFF }),
        llm: { openrouter: llm as never, openai: llm as never },
      },
    });
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);

    const hit = (url: string) => app.inject({ method: 'POST', url });
    const generate: number[] = [];
    for (let i = 0; i < 11; i++) generate.push((await hit(`/pulls/${pr.id}/brief`)).statusCode);
    expect(generate.at(-1)).toBe(429);

    const regen: number[] = [];
    for (let i = 0; i < 11; i++)
      regen.push((await hit(`/pulls/${pr.id}/brief/regenerate`)).statusCode);
    expect(regen.at(-1)).toBe(429);

    // A limit on one route is not a limit on the feature — but the read stays free.
    const read = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/brief` });
    expect(read.statusCode).toBe(200);
  });

  it('ledgers an unavailable blast radius with the index’s own reason (AC-34, EC-10)', async () => {
    const { app } = appWith();
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);

    const brief = (await (await app).inject({ method: 'POST', url: `/pulls/${pr.id}/brief` })).json();
    const blast = brief.inputs.find((e: { section: string }) => e.section === 'blast_radius');

    // The repo was never indexed, so this must say so — and say why.
    expect(blast?.status).toBe('unavailable');
    expect(blast?.reason).toBeTruthy();
  });

  it('ledgers a linked issue whose fetch fails, and still generates (AC-35, EC-14)', async () => {
    class FailingGitHub extends MockGitHubClient {
      async getIssue(): Promise<never> {
        throw new Error('Bad credentials');
      }
    }
    const llm = new MockLLMProvider('openai', { structured: BRIEF_FIXTURE });
    const app = await buildApp({
      config: config(),
      db: pg.handle.db,
      overrides: {
        embedder: new MockEmbedder(),
        github: new FailingGitHub(),
        git: new MockGitClient({ diff: DIFF }),
        llm: { openrouter: llm as never, openai: llm as never },
      },
    });
    // The seeded body says "Closes #471", so an issue IS named and IS fetched.
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);

    const res = await app.inject({ method: 'POST', url: `/pulls/${pr.id}/brief` });
    expect(res.statusCode).toBe(200);

    const issue = res.json().inputs.find((e: { section: string }) => e.section === 'linked_issue');
    expect(issue?.status).toBe('unavailable');
    expect(issue?.reason).toBeTruthy();
    // A missing issue degrades the brief; it must not fail it.
    expect(structuredCalls(llm)).toHaveLength(1);
  });

  it('refuses a PR whose protected floor exceeds the budget, spending nothing (AC-61, EC-21)', async () => {
    // The prompt's changed-file list comes from the PARSED DIFF, not from
    // pr_files, so the floor has to be made large there. High-entropy segments
    // on purpose: a repeated path fragment compresses to a handful of BPE
    // tokens and 400 characters then cost almost nothing.
    const hugePaths = Array.from({ length: 80 }, (_, i) =>
      `src/${Array.from({ length: 24 }, (_, k) =>
        `${(i * 7919 + k * 104729).toString(36)}-seg${k}`,
      ).join('/')}/mod-${i}.ts`.slice(0, 400),
    );
    const hugeDiff = hugePaths
      .map(
        (path) =>
          `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,2 @@\n ctx\n+added`,
      )
      .join('\n');
    const llm = new MockLLMProvider('openai', { structured: BRIEF_FIXTURE });
    const app = await buildApp({
      config: config(),
      db: pg.handle.db,
      overrides: {
        embedder: new MockEmbedder(),
        github: new MockGitHubClient(),
        git: new MockGitClient({ diff: hugeDiff }),
        llm: { openrouter: llm as never, openai: llm as never },
      },
    });
    const name = `brief-floor-${repoSeq++}`;
    const [repo] = await pg.handle.db
      .insert(t.repos)
      .values({ workspaceId, owner: 'acme', name, fullName: `acme/${name}` })
      .returning();
    const [pr] = await pg.handle.db
      .insert(t.pullRequests)
      .values({
        workspaceId,
        repoId: repo!.id,
        number: 999,
        title: 'A pull request whose mandatory inputs alone cannot fit',
        author: 'marisa.koch',
        branch: 'feat/enormous',
        base: 'main',
        headSha: 'head-huge',
        additions: 1,
        deletions: 0,
        filesCount: 80,
        status: 'needs_review',
        body: 'No linked issue.',
      })
      .returning();
    // Changed file paths are protected: AC-14 may never shed them, and AC-60
    // bounds each at MAX_PATH_CHARS. 80 files at that bound is a floor no
    // shedding order can reach.
    await pg.handle.db.insert(t.prFiles).values(
      hugePaths.map((path) => ({
        prId: pr!.id,
        path,
        additions: 1,
        deletions: 0,
        patch: '@@ -1,1 +1,2 @@\n ctx\n+added',
      })),
    );

    const res = await app.inject({ method: 'POST', url: `/pulls/${pr!.id}/brief` });

    expect(res.statusCode).toBe(422);
    expect(res.body).toMatch(/input budget/i);
    // The whole reason AC-61 exists: refuse BEFORE the money is spent.
    expect(structuredCalls(llm)).toHaveLength(0);
    const rows = await pg.handle.db.select().from(t.prBrief).where(eq(t.prBrief.prId, pr!.id));
    expect(rows).toHaveLength(0);
  });

  it('ledgers a pull request that names no issue at all (AC-35)', async () => {
    const { app, llm } = appWith();
    const name = `brief-noissue-${repoSeq++}`;
    const [repo] = await pg.handle.db
      .insert(t.repos)
      .values({ workspaceId, owner: 'acme', name, fullName: `acme/${name}` })
      .returning();
    const [pr] = await pg.handle.db
      .insert(t.pullRequests)
      .values({
        workspaceId,
        repoId: repo!.id,
        number: 483,
        title: 'Add rate limiting to public API endpoints',
        author: 'marisa.koch',
        branch: 'feat/rate-limit',
        base: 'main',
        headSha: 'head-one',
        additions: 1,
        deletions: 0,
        filesCount: 1,
        status: 'needs_review',
        body: 'This body references no issue whatsoever.',
      })
      .returning();
    await pg.handle.db.insert(t.prFiles).values({
      prId: pr!.id,
      path: 'src/config.ts',
      additions: 1,
      deletions: 0,
      patch: '@@ -10,3 +10,4 @@\n ctx\n+added',
    });

    const res = await (await app).inject({ method: 'POST', url: `/pulls/${pr!.id}/brief` });
    expect(res.statusCode).toBe(200);

    // "No issue was named" and "the issue could not be fetched" are both inputs
    // the brief did not get. A ledger that records only the second makes the
    // first look like an input nobody even looked for.
    const issue = res.json().inputs.find((e: { section: string }) => e.section === 'linked_issue');
    expect(issue?.status).toBe('unavailable');
    expect(issue?.reason).toMatch(/names no issue/i);
    // No issue named means no GitHub call at all.
    expect(structuredCalls(llm)).toHaveLength(1);
  });

  it('ledgers the per-file hunk cap as a reduced input (AC-62)', async () => {
    // 15 hunks in one file, against a cap of 12.
    const hunks = Array.from(
      { length: 15 },
      (_, i) => `@@ -${i * 10 + 1},2 +${i * 10 + 1},3 @@\n ctx\n+added-${i}`,
    ).join('\n');
    const bigDiff = `diff --git a/src/wide.ts b/src/wide.ts\n--- a/src/wide.ts\n+++ b/src/wide.ts\n${hunks}`;
    const llm = new MockLLMProvider('openai', { structured: BRIEF_FIXTURE });
    const app = await buildApp({
      config: config(),
      db: pg.handle.db,
      overrides: {
        embedder: new MockEmbedder(),
        github: new MockGitHubClient(),
        git: new MockGitClient({ diff: bigDiff }),
        llm: { openrouter: llm as never, openai: llm as never },
      },
    });
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);

    const res = await app.inject({ method: 'POST', url: `/pulls/${pr.id}/brief` });
    expect(res.statusCode).toBe(200);

    // The prompt says so in prose; AC-62 asks the LEDGER to say so, so a reader
    // of `inputs` can see the reduction without reading the prompt text.
    const entry = res
      .json()
      .inputs.find(
        (e: { section: string; reason?: string }) =>
          e.section === 'hunk_headers' && /hunk header\(s\) omitted/.test(e.reason ?? ''),
      );
    expect(entry).toBeDefined();
    expect(entry.status).toBe('present');
    expect(entry.reason).toMatch(/capped at 12 hunks/);
  });

  it('hands back an already-stored newer brief instead of charging again (AC-64, EC-20)', async () => {
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);
    const gate = deferred();
    const llm = new MockLLMProvider('openai', { structured: BRIEF_FIXTURE });
    const held = holdStructured(llm, gate.promise);
    const app = await buildApp({
      config: config(),
      db: pg.handle.db,
      overrides: {
        embedder: new MockEmbedder(),
        github: new MockGitHubClient(),
        git: new MockGitClient({ diff: DIFF }),
        llm: { openrouter: held.provider as never, openai: held.provider as never },
      },
    });

    const inFlight = app.inject({ method: 'POST', url: `/pulls/${pr.id}/brief` });
    await held.entered;

    // While head-one is being briefed, the PR moves AND somebody stores a brief
    // for the new head — the case EC-20 actually describes.
    await pg.handle.db
      .update(t.pullRequests)
      .set({ headSha: 'head-two' })
      .where(eq(t.pullRequests.id, pr.id));
    await pg.handle.db.insert(t.prBrief).values({
      prId: pr.id,
      headSha: 'head-two',
      json: { ...BRIEF_FIXTURE, risks: [], review_focus: [], inputs: [], counts: {
        risks_proposed: 0, risks_kept: 0, focus_proposed: 0, focus_kept: 0,
      } } as never,
      provider: 'openrouter',
      model: 'deepseek/deepseek-v4-pro',
      tokensIn: 10,
      tokensOut: 5,
      costUsd: '0.0001',
    });

    gate.resolve();
    const res = await inFlight;

    // Not a 409: a correct brief for the current head already exists, so the
    // caller gets it rather than being told to pay for another generation.
    expect(res.statusCode).toBe(200);
    expect(res.json().head_sha).toBe('head-two');
    expect(res.json().tokens_in).toBe(10);

    // The head-one result was discarded, not written over the head-two row.
    const rows = await pg.handle.db.select().from(t.prBrief).where(eq(t.prBrief.prId, pr.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.headSha).toBe('head-two');
  });

  it('404s an unknown PR and 422s a non-uuid id (AC-1)', async () => {
    const { app } = appWith();
    const built = await app;
    const missing = await built.inject({
      method: 'GET',
      url: '/pulls/00000000-0000-4000-8000-000000000000/brief',
    });
    expect(missing.statusCode).toBe(404);
    const bad = await built.inject({ method: 'GET', url: '/pulls/not-a-uuid/brief' });
    expect(bad.statusCode).toBe(422);
  });
});
