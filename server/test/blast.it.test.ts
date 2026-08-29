import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import { MockEmbedder, MockGitClient, MockGitHubClient } from '../src/adapters/mocks.js';
import * as t from '../src/db/schema.js';

/**
 * Blast route, end to end against a real Postgres.
 *
 * The assertions a unit test cannot make are the workspace guard, the prior-PR
 * overlap SQL, and the promise that an UNINDEXED repo answers 200 with an empty
 * radius rather than 404/500 — the panel's empty state depends on that.
 */

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const config = () => loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);

let seq = 0;

async function setupRepo(db: PgFixture['handle']['db'], workspaceId: string) {
  const name = `blast-api-${seq++}`;
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
  paths: string[],
) {
  const [pr] = await db
    .insert(t.pullRequests)
    .values({
      workspaceId,
      repoId,
      number,
      title: `PR #${number}`,
      author: 'marisa.koch',
      branch: `feat/b${number}`,
      base: 'main',
      headSha: `sha-${number}`,
      filesCount: paths.length,
      status: 'needs_review',
      updatedAt: new Date(`2026-08-0${Math.min(number, 9)}T09:00:00.000Z`),
    })
    .returning();
  for (const path of paths) {
    await db.insert(t.prFiles).values({ prId: pr!.id, path, additions: 1, deletions: 0 });
  }
  return pr!;
}

d('Blast route (Testcontainers pg)', () => {
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
    return buildApp({
      config: config(),
      db: pg.handle.db,
      overrides: {
        embedder: new MockEmbedder(),
        github: new MockGitHubClient(),
        git: new MockGitClient({ diff: '' }),
      },
    });
  }

  it('answers 200 with an empty radius for an unindexed repo', async () => {
    const app = await appWith();
    const repo = await setupRepo(pg.handle.db, workspaceId);
    const pr = await setupPr(pg.handle.db, workspaceId, repo.id, 1, ['src/api/rateLimit.ts']);

    const res = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/blast` });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.blast.changed_symbols).toEqual([]);
    expect(body.blast.downstream).toEqual([]);
    expect(body.blast.impacted_endpoints).toEqual([]);
    expect(body.blast.summary).toMatch(/No indexed symbols/);
    expect(body.history).toEqual([]);
  });

  it('lists prior PRs in the same repo that touch an overlapping file', async () => {
    const app = await appWith();
    const repo = await setupRepo(pg.handle.db, workspaceId);
    const older = await setupPr(pg.handle.db, workspaceId, repo.id, 2, [
      'src/server.ts',
      'src/unrelated.ts',
    ]);
    const current = await setupPr(pg.handle.db, workspaceId, repo.id, 3, [
      'src/server.ts',
      'src/api/rateLimit.ts',
    ]);

    const res = await app.inject({ method: 'GET', url: `/pulls/${current.id}/blast` });
    const body = res.json();

    expect(res.statusCode).toBe(200);
    expect(body.history).toHaveLength(1);
    expect(body.history[0].pr_number).toBe(older.number);
    // Only the OVERLAPPING path is reported, not the prior PR's whole file list.
    expect(body.history[0].files_overlap).toEqual(['src/server.ts']);
  });

  it('excludes the current PR from its own history', async () => {
    const app = await appWith();
    const repo = await setupRepo(pg.handle.db, workspaceId);
    const pr = await setupPr(pg.handle.db, workspaceId, repo.id, 4, ['src/only.ts']);

    const res = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/blast` });
    expect(res.json().history).toEqual([]);
  });

  it('does not leak a PR from another workspace', async () => {
    const app = await appWith();
    const [otherWs] = await pg.handle.db
      .insert(t.workspaces)
      .values({ name: 'other-ws' })
      .returning();
    const repo = await setupRepo(pg.handle.db, otherWs!.id);
    const pr = await setupPr(pg.handle.db, otherWs!.id, repo.id, 5, ['src/secret.ts']);

    const res = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/blast` });
    expect(res.statusCode).toBe(404);
  });
});
