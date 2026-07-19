import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { deflateRawSync } from 'node:zlib';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';
import { MockGitClient, MockGitHubClient } from '../src/adapters/mocks.js';
import { SkillsRepository } from '../src/modules/skills/repository.js';
import { SkillsService } from '../src/modules/skills/service.js';
import type { Container } from '../src/platform/container.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

if (!hasDocker) {
  // eslint-disable-next-line no-console
  console.warn('[skills] Docker not available — skipping integration tests.');
}

/**
 * Skills CRUD + the version-on-body-change rule, exercised through the HTTP
 * surface. The interesting invariant: only a body edit appends a
 * `skill_versions` row — a rename or an enable toggle must not.
 */
d('skills module', () => {
  let pg: PgFixture;

  beforeAll(async () => {
    pg = await startPg();
    await seed(pg.handle.db);
  });
  afterAll(async () => {
    await pg?.stop();
  });

  function makeApp() {
    const config = loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    return buildApp({
      config,
      db: pg.handle.db,
      overrides: { git: new MockGitClient(), github: new MockGitHubClient() },
    });
  }

  const createBody = {
    name: 'pr-quality-rubric',
    description: 'Rubric for evaluating PR quality.',
    type: 'rubric' as const,
    body: '# PR Quality Rubric\n\nCheck naming, tests, and error handling.',
  };

  it('creates a skill at version 1 with a matching version snapshot', async () => {
    const app = await makeApp();
    const created = await app.inject({ method: 'POST', url: '/skills', payload: createBody });
    expect(created.statusCode).toBe(201);
    const skill = created.json();
    expect(skill).toMatchObject({
      name: 'pr-quality-rubric',
      type: 'rubric',
      source: 'manual',
      enabled: true,
      version: 1,
    });

    const versions = (
      await app.inject({ method: 'GET', url: `/skills/${skill.id}/versions` })
    ).json();
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ version: 1, body: createBody.body });
    await app.close();
  });

  it('a body edit bumps the version and appends a snapshot (newest first)', async () => {
    const app = await makeApp();
    const id = (await app.inject({ method: 'POST', url: '/skills', payload: createBody })).json()
      .id as string;

    const updated = await app.inject({
      method: 'PUT',
      url: `/skills/${id}`,
      payload: { body: '# PR Quality Rubric\n\nNow also check migrations.' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().version).toBe(2);

    const versions = (await app.inject({ method: 'GET', url: `/skills/${id}/versions` })).json();
    expect(versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect(versions[0].body).toContain('migrations');
    expect(versions[1].body).toBe(createBody.body);
    await app.close();
  });

  it('renaming / toggling enabled does NOT create a new version', async () => {
    const app = await makeApp();
    const id = (await app.inject({ method: 'POST', url: '/skills', payload: createBody })).json()
      .id as string;

    await app.inject({
      method: 'PUT',
      url: `/skills/${id}`,
      payload: { name: 'renamed', description: 'new desc', type: 'custom', enabled: false },
    });

    const after = (await app.inject({ method: 'GET', url: `/skills/${id}` })).json();
    expect(after).toMatchObject({ name: 'renamed', type: 'custom', enabled: false, version: 1 });
    expect((await app.inject({ method: 'GET', url: `/skills/${id}/versions` })).json()).toHaveLength(
      1,
    );
    await app.close();
  });

  it('re-saving an identical body is a no-op for the version history', async () => {
    const app = await makeApp();
    const id = (await app.inject({ method: 'POST', url: '/skills', payload: createBody })).json()
      .id as string;
    await app.inject({ method: 'PUT', url: `/skills/${id}`, payload: { body: createBody.body } });
    expect((await app.inject({ method: 'GET', url: `/skills/${id}/versions` })).json()).toHaveLength(
      1,
    );
    await app.close();
  });

  it('lists, fetches one, and deletes', async () => {
    const app = await makeApp();
    const id = (
      await app.inject({
        method: 'POST',
        url: '/skills',
        payload: { ...createBody, name: 'to-be-deleted' },
      })
    ).json().id as string;

    const list = (await app.inject({ method: 'GET', url: '/skills' })).json();
    expect(list.some((s: { id: string }) => s.id === id)).toBe(true);

    expect((await app.inject({ method: 'GET', url: `/skills/${id}` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `/skills/${id}` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/skills/${id}` })).statusCode).toBe(404);
    await app.close();
  });

  it('deleting a skill cascades its agent links', async () => {
    const app = await makeApp();
    const skillId = (
      await app.inject({ method: 'POST', url: '/skills', payload: { ...createBody, name: 'linked' } })
    ).json().id as string;
    const agentId = (
      await app.inject({
        method: 'POST',
        url: '/agents',
        payload: {
          name: 'Linker',
          provider: 'openai',
          model: 'gpt-4o-mini',
          system_prompt: 'Review.',
        },
      })
    ).json().id as string;

    await app.inject({
      method: 'POST',
      url: `/agents/${agentId}/skills`,
      payload: { skill_ids: [skillId] },
    });
    expect(
      (await app.inject({ method: 'GET', url: `/agents/${agentId}/skills` })).json(),
    ).toHaveLength(1);

    await app.inject({ method: 'DELETE', url: `/skills/${skillId}` });
    expect(
      (await app.inject({ method: 'GET', url: `/agents/${agentId}/skills` })).json(),
    ).toHaveLength(0);
    await app.close();
  });

  it('404s for unknown skills and versions; 422 for a bad :version', async () => {
    const app = await makeApp();
    const id = (await app.inject({ method: 'POST', url: '/skills', payload: createBody })).json()
      .id as string;
    const ghost = '00000000-0000-0000-0000-000000000000';

    expect((await app.inject({ method: 'GET', url: `/skills/${ghost}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/skills/${ghost}/versions` })).statusCode).toBe(
      404,
    );
    expect((await app.inject({ method: 'GET', url: `/skills/${id}/versions/99` })).statusCode).toBe(
      404,
    );
    expect((await app.inject({ method: 'GET', url: `/skills/${id}/versions/abc` })).statusCode).toBe(
      422,
    );
    expect((await app.inject({ method: 'DELETE', url: `/skills/${ghost}` })).statusCode).toBe(404);
    await app.close();
  });

  it('an imported skill is created disabled even if the client asks for enabled', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/skills',
      payload: {
        name: 'community-thing',
        body: '# Community Thing\n\nDo the thing.',
        source: 'community',
        enabled: true,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ source: 'community', enabled: false });
    await app.close();
  });

  // ---- import preview: parse only, persists nothing -----------------------

  function zipWith(files: { name: string; content: string }[]): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const f of files) {
      const raw = Buffer.from(f.content, 'utf8');
      const data = deflateRawSync(raw);
      const name = Buffer.from(f.name, 'utf8');
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(8, 8);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(raw.length, 22);
      local.writeUInt16LE(name.length, 26);
      locals.push(local, name, data);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(8, 10);
      central.writeUInt32LE(data.length, 20);
      central.writeUInt32LE(raw.length, 24);
      central.writeUInt16LE(name.length, 28);
      central.writeUInt32LE(offset, 42);
      centrals.push(central, name);
      offset += local.length + name.length + data.length;
    }
    const localBuf = Buffer.concat(locals);
    const centralBuf = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(files.length, 8);
    eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(centralBuf.length, 12);
    eocd.writeUInt32LE(localBuf.length, 16);
    return Buffer.concat([localBuf, centralBuf, eocd]);
  }

  it('previews a .md upload with no skipped files and stores nothing', async () => {
    const app = await makeApp();
    const before = (await app.inject({ method: 'GET', url: '/skills' })).json().length;

    const res = await app.inject({
      method: 'POST',
      url: '/skills/import/preview',
      payload: {
        filename: 'phantom-api-gate.md',
        content_base64: Buffer.from(
          '---\nname: phantom-api-gate\ntype: security\n---\n\n# Phantom API Gate\n\nDetects imports of APIs that do not exist.\n',
        ).toString('base64'),
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      name: 'phantom-api-gate',
      type: 'security',
      source: 'imported_url',
      skipped_files: [],
    });
    expect(res.json().body).toContain('# Phantom API Gate');

    const after = (await app.inject({ method: 'GET', url: '/skills' })).json().length;
    expect(after).toBe(before);
    await app.close();
  });

  it('previews a .zip, listing non-markdown entries as skipped', async () => {
    const app = await makeApp();
    const zip = zipWith([
      { name: 'scripts/run.sh', content: '#!/bin/sh\nrm -rf /' },
      { name: 'SKILL.md', content: '# Zipped Skill\n\nFrom an archive.' },
      { name: 'install.js', content: 'evil()' },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/skills/import/preview',
      payload: { filename: 'skill.zip', content_base64: zip.toString('base64') },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      name: 'Zipped Skill',
      description: 'From an archive.',
      source: 'imported_url',
      skipped_files: ['scripts/run.sh', 'install.js'],
    });
    await app.close();
  });

  it('rejects an archive with no markdown, and a traversal path', async () => {
    const app = await makeApp();
    const noMd = zipWith([{ name: 'run.sh', content: 'x' }]);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/skills/import/preview',
          payload: { filename: 'a.zip', content_base64: noMd.toString('base64') },
        })
      ).statusCode,
    ).toBe(422);

    const traversal = zipWith([{ name: '../escape.md', content: '# x' }]);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/skills/import/preview',
          payload: { filename: 'a.zip', content_base64: traversal.toString('base64') },
        })
      ).statusCode,
    ).toBe(422);
    await app.close();
  });

  it('is workspace-scoped: another tenant cannot read or version a skill', async () => {
    const { db } = pg.handle;
    const [otherWs] = await db.insert(t.workspaces).values({ name: 'skills-other' }).returning();
    const repo = new SkillsRepository(db);
    const foreign = await repo.insert({
      workspaceId: otherWs!.id,
      name: 'Foreign',
      description: 'x',
      type: 'custom',
      source: 'manual',
      body: '# Foreign',
    });

    const service = new SkillsService({ db, skillsRepo: repo } as unknown as Container);
    const [{ id: defaultWs }] = await db
      .select({ id: t.workspaces.id })
      .from(t.workspaces)
      .where(eq(t.workspaces.name, 'default'));

    expect(await service.listVersions(otherWs!.id, foreign.id)).toHaveLength(1);
    expect(await service.listVersions(defaultWs!, foreign.id)).toBeUndefined();
    expect(await service.getVersion(defaultWs!, foreign.id, 1)).toBeUndefined();
    expect(await service.get(defaultWs!, foreign.id)).toBeUndefined();
    expect(await service.update(defaultWs!, foreign.id, { body: 'hacked' })).toBeUndefined();
    expect(await service.delete(defaultWs!, foreign.id)).toBe(false);
  });
});
