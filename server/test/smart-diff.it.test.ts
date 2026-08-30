import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import {
  MockEmbedder,
  MockGitClient,
  MockGitHubClient,
  MockLLMProvider,
} from '../src/adapters/mocks.js';
import * as t from '../src/db/schema.js';

/**
 * Smart-diff route, end to end against a real Postgres.
 *
 * The assertions a unit test cannot make are the workspace guard, the
 * latest-ROUND findings join (one Run Review click = several agents sharing a
 * `ran_at`), the seeded-review fallback for reviews with no `run_id`, and the
 * promise that a PR with NO review answers 200 with empty `finding_lines`
 * rather than 404 — the viewer's pre-review state depends on that.
 */

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const config = () => loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);

let seq = 0;

async function setupRepo(db: PgFixture['handle']['db'], workspaceId: string) {
  const name = `smart-diff-api-${seq++}`;
  const [repo] = await db
    .insert(t.repos)
    .values({ workspaceId, owner: 'acme', name, fullName: `acme/${name}` })
    .returning();
  return repo!;
}

async function setupPr(
  db: PgFixture['handle']['db'],
  workspaceId: string,
  repoId: string,
  number: number,
  files: { path: string; additions?: number; deletions?: number }[],
) {
  const [pr] = await db
    .insert(t.pullRequests)
    .values({
      workspaceId,
      repoId,
      number,
      title: `PR #${number}`,
      author: 'marisa.koch',
      branch: `feat/sd${number}`,
      base: 'main',
      headSha: `sha-${number}`,
      filesCount: files.length,
      status: 'needs_review',
      updatedAt: new Date('2026-08-05T09:00:00.000Z'),
    })
    .returning();
  for (const f of files) {
    await db.insert(t.prFiles).values({
      prId: pr!.id,
      path: f.path,
      additions: f.additions ?? 1,
      deletions: f.deletions ?? 0,
    });
  }
  return pr!;
}

/** One agent's pass within a review round: an agent_run + its review + findings. */
async function setupReview(
  db: PgFixture['handle']['db'],
  workspaceId: string,
  prId: string,
  ranAt: Date,
  findings: { file: string; startLine: number; severity: string }[],
) {
  const [run] = await db
    .insert(t.agentRuns)
    .values({ workspaceId, prId, ranAt, status: 'done' })
    .returning();
  const [review] = await db
    .insert(t.reviews)
    .values({ workspaceId, prId, runId: run!.id, kind: 'review', verdict: 'comment' })
    .returning();
  for (const f of findings) {
    await db.insert(t.findings).values({
      reviewId: review!.id,
      file: f.file,
      startLine: f.startLine,
      endLine: f.startLine,
      severity: f.severity,
      category: 'bug',
      title: `finding at ${f.file}:${f.startLine}`,
      rationale: 'because',
      confidence: 0.9,
    });
  }
  return review!;
}

const FILES = [
  { path: 'src/middleware/ratelimit.ts', additions: 84, deletions: 0 },
  { path: 'src/api/public/webhooks.ts', additions: 31, deletions: 6 },
  { path: 'src/api/public/index.ts', additions: 12, deletions: 2 },
  { path: 'package-lock.json', additions: 92, deletions: 24 },
];

const groupOf = (body: { groups: { role: string; files: { path: string }[] }[] }, role: string) =>
  body.groups.find((g) => g.role === role)!;

d('Smart-diff route (Testcontainers pg)', () => {
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

  /**
   * Every provider the container can resolve, mocked.
   *
   * `ContainerOverrides.llm` is a PARTIAL record, so leaving one out is silent:
   * the un-injected provider falls through to the real secrets file, finds a
   * key, and makes live billed calls (server/INSIGHTS.md, 2026-08-11). Smart
   * Diff must not reach a model at all, so all three go in.
   *
   * `MockLLMProvider`'s constructor only accepts 'openai' | 'anthropic'. That
   * is fine: `container.llm(id)` looks the provider up by KEY and never
   * inspects `provider.id`, so the openrouter slot takes an openai-flavoured
   * mock.
   */
  function llmMocks() {
    return {
      openai: new MockLLMProvider('openai'),
      anthropic: new MockLLMProvider('anthropic'),
      openrouter: new MockLLMProvider('openai'),
    };
  }

  function appWith(llm: ReturnType<typeof llmMocks> = llmMocks()) {
    return buildApp({
      config: config(),
      db: pg.handle.db,
      overrides: {
        embedder: new MockEmbedder(),
        github: new MockGitHubClient(),
        git: new MockGitClient({ diff: '' }),
        llm,
      },
    });
  }

  it('groups files core → wiring → boilerplate before any review has run', async () => {
    const app = await appWith();
    const repo = await setupRepo(pg.handle.db, workspaceId);
    const pr = await setupPr(pg.handle.db, workspaceId, repo.id, 1, FILES);

    const res = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/smart-diff` });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.groups.map((g: { role: string }) => g.role)).toEqual([
      'core',
      'wiring',
      'boilerplate',
    ]);
    expect(groupOf(body, 'core').files.map((f) => f.path)).toEqual([
      'src/middleware/ratelimit.ts',
      'src/api/public/webhooks.ts',
    ]);
    expect(groupOf(body, 'wiring').files.map((f) => f.path)).toEqual(['src/api/public/index.ts']);
    expect(groupOf(body, 'boilerplate').files.map((f) => f.path)).toEqual(['package-lock.json']);
  });

  it('returns empty finding_lines — not 404 — when the PR has no review yet', async () => {
    const app = await appWith();
    const repo = await setupRepo(pg.handle.db, workspaceId);
    const pr = await setupPr(pg.handle.db, workspaceId, repo.id, 2, FILES);

    const res = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/smart-diff` });
    const body = res.json();

    expect(res.statusCode).toBe(200);
    const all = body.groups.flatMap((g: { files: { finding_lines: number[] }[] }) => g.files);
    expect(all).toHaveLength(FILES.length);
    expect(all.every((f: { finding_lines: number[] }) => f.finding_lines.length === 0)).toBe(true);
  });

  it('attaches finding lines from EVERY agent in the latest round', async () => {
    const app = await appWith();
    const repo = await setupRepo(pg.handle.db, workspaceId);
    const pr = await setupPr(pg.handle.db, workspaceId, repo.id, 3, FILES);

    const latest = new Date('2026-08-06T12:00:00.000Z');
    // Two agents, one Run Review click → same ran_at, two reviews.
    await setupReview(pg.handle.db, workspaceId, pr.id, latest, [
      { file: 'src/api/public/webhooks.ts', startLine: 61, severity: 'CRITICAL' },
    ]);
    await setupReview(pg.handle.db, workspaceId, pr.id, latest, [
      { file: 'src/api/public/webhooks.ts', startLine: 73, severity: 'CRITICAL' },
      { file: 'src/middleware/ratelimit.ts', startLine: 28, severity: 'SUGGESTION' },
    ]);

    const res = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/smart-diff` });
    const core = groupOf(res.json(), 'core');
    const byPath = new Map(
      core.files.map((f) => [f.path, (f as { finding_lines: number[] }).finding_lines]),
    );

    expect(res.statusCode).toBe(200);
    expect(byPath.get('src/api/public/webhooks.ts')).toEqual([61, 73]);
    expect(byPath.get('src/middleware/ratelimit.ts')).toEqual([28]);
  });

  it('ignores findings from a superseded earlier round', async () => {
    const app = await appWith();
    const repo = await setupRepo(pg.handle.db, workspaceId);
    const pr = await setupPr(pg.handle.db, workspaceId, repo.id, 4, FILES);

    await setupReview(pg.handle.db, workspaceId, pr.id, new Date('2026-08-01T10:00:00.000Z'), [
      { file: 'src/middleware/ratelimit.ts', startLine: 999, severity: 'CRITICAL' },
    ]);
    await setupReview(pg.handle.db, workspaceId, pr.id, new Date('2026-08-07T10:00:00.000Z'), [
      { file: 'src/middleware/ratelimit.ts', startLine: 28, severity: 'WARNING' },
    ]);

    const res = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/smart-diff` });
    const core = groupOf(res.json(), 'core');
    const lines = (core.files.find((f) => f.path === 'src/middleware/ratelimit.ts') as {
      finding_lines: number[];
    }).finding_lines;

    expect(lines).toEqual([28]);
  });

  it('stays empty when the latest round ran and found nothing, despite older findings', async () => {
    const app = await appWith();
    const repo = await setupRepo(pg.handle.db, workspaceId);
    const pr = await setupPr(pg.handle.db, workspaceId, repo.id, 8, FILES);

    // An older review DID flag a line; the newest round cleared it.
    await setupReview(pg.handle.db, workspaceId, pr.id, new Date('2026-08-01T10:00:00.000Z'), [
      { file: 'src/middleware/ratelimit.ts', startLine: 28, severity: 'CRITICAL' },
    ]);
    await setupReview(pg.handle.db, workspaceId, pr.id, new Date('2026-08-09T10:00:00.000Z'), []);

    const res = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/smart-diff` });
    const all = res.json().groups.flatMap((g: { files: { finding_lines: number[] }[] }) => g.files);

    // Resurrecting the cleared finding would be a lie about the current state.
    expect(all.every((f: { finding_lines: number[] }) => f.finding_lines.length === 0)).toBe(true);
  });

  it('falls back to the newest review when it has no agent_run (seeded data)', async () => {
    const app = await appWith();
    const repo = await setupRepo(pg.handle.db, workspaceId);
    const pr = await setupPr(pg.handle.db, workspaceId, repo.id, 5, FILES);

    // No agent_runs row at all — exactly how the seeder writes reviews.
    const [review] = await pg.handle.db
      .insert(t.reviews)
      .values({ workspaceId, prId: pr.id, kind: 'review', verdict: 'comment' })
      .returning();
    await pg.handle.db.insert(t.findings).values({
      reviewId: review!.id,
      file: 'src/api/public/webhooks.ts',
      startLine: 42,
      endLine: 42,
      severity: 'WARNING',
      category: 'bug',
      title: 'seeded finding',
      rationale: 'because',
      confidence: 0.8,
    });

    const res = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/smart-diff` });
    const core = groupOf(res.json(), 'core');
    const lines = (core.files.find((f) => f.path === 'src/api/public/webhooks.ts') as {
      finding_lines: number[];
    }).finding_lines;

    expect(res.statusCode).toBe(200);
    expect(lines).toEqual([42]);
  });

  it('flags an oversized PR and proposes splits from its core files', async () => {
    const app = await appWith();
    const repo = await setupRepo(pg.handle.db, workspaceId);
    const pr = await setupPr(pg.handle.db, workspaceId, repo.id, 6, [
      { path: 'billing/charge.ts', additions: 300, deletions: 0 },
      { path: 'billing/refund.ts', additions: 120, deletions: 0 },
      { path: 'package-lock.json', additions: 900, deletions: 0 },
    ]);

    const res = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/smart-diff` });
    const split = res.json().split_suggestion;

    expect(split.too_big).toBe(true);
    expect(split.total_lines).toBe(1320);
    expect(split.proposed_splits).toEqual([
      { name: 'billing', files: ['billing/charge.ts', 'billing/refund.ts'] },
    ]);
  });

  it('does not leak a PR from another workspace', async () => {
    const app = await appWith();
    const [otherWs] = await pg.handle.db
      .insert(t.workspaces)
      .values({ name: 'other-ws-smart-diff' })
      .returning();
    const repo = await setupRepo(pg.handle.db, otherWs!.id);
    const pr = await setupPr(pg.handle.db, otherWs!.id, repo.id, 7, FILES);

    const res = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/smart-diff` });
    expect(res.statusCode).toBe(404);
  });

  it('serves the whole response without calling a model', async () => {
    // The acceptance criterion, asserted rather than trusted: viewing Smart
    // Diff must produce no LLM call. This is the runtime half of the invariant
    // -- smart-diff-no-llm.test.ts pins it statically.
    //
    // Exercised on the richest path on purpose: a PR with files AND findings
    // from a real round, so classification, the findings join and the split
    // suggestion all run before the assertion.
    const llm = llmMocks();
    const app = await appWith(llm);
    const repo = await setupRepo(pg.handle.db, workspaceId);
    const pr = await setupPr(pg.handle.db, workspaceId, repo.id, 8, FILES);
    await setupReview(pg.handle.db, workspaceId, pr.id, new Date('2026-08-05T10:00:00.000Z'), [
      { file: 'src/middleware/ratelimit.ts', startLine: 12, severity: 'CRITICAL' },
      { file: 'package-lock.json', startLine: 40, severity: 'SUGGESTION' },
    ]);

    const res = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/smart-diff` });

    // The request did the real work...
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(groupOf(body, 'core').files[0]!.finding_lines).toEqual([12]);
    expect(groupOf(body, 'boilerplate').files[0]!.finding_lines).toEqual([40]);

    // ...and reached no provider while doing it.
    for (const [id, mock] of Object.entries(llm)) {
      expect(mock.calls, `smart-diff called the ${id} provider`).toEqual([]);
    }
  });
});
