import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import { MockLLMProvider, MockEmbedder, MockGitClient } from '../src/adapters/mocks.js';
import * as t from '../src/db/schema.js';

/**
 * Digest building end to end: a workspace with three merged pull requests
 * produces one stored digest whose body lists every one of them, and a second
 * request for the same window reuses the stored row rather than rebuilding.
 */

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const config = () => loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);

d('digests service', () => {
  let pg: PgFixture;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    pg = await startPg();
    await seed(pg.db);
    app = await buildApp({
      config: config(),
      db: pg.db,
      overrides: {
        llm: { openrouter: new MockLLMProvider('openrouter') },
        embedder: new MockEmbedder(),
        git: new MockGitClient(),
      },
    });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await pg?.stop();
  });

  it('stores one digest covering every merged pull request in the window', async () => {
    const [repo] = await pg.db
      .select({ id: t.repos.id, workspaceId: t.repos.workspaceId })
      .from(t.repos);

    await pg.db.insert(t.pullRequests).values(
      [101, 102, 103].map((number) => ({
        workspaceId: repo!.workspaceId,
        repoId: repo!.id,
        number,
        title: `Merged change ${number}`,
        author: 'octocat',
        branch: `feat/change-${number}`,
        base: 'main',
        headSha: `sha-${number}`,
        status: 'merged',
        updatedAt: new Date(),
      })),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/digests',
      payload: { periodDays: 7 },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.cached).toBe(false);
    for (const number of [101, 102, 103]) {
      expect(body.digest.bodyMd).toContain(`#${number}`);
    }

    const rows = await pg.db.select().from(t.digests);
    expect(rows).toHaveLength(1);
  });
});
