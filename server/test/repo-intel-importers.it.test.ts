import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { seed } from '../src/db/seed.js';
import { RepoIntelRepository } from '../src/modules/repo-intel/repository.js';
import * as t from '../src/db/schema.js';

/**
 * `getImporters` — the REVERSE import walk.
 *
 * This is the query the blast radius is built on, and its direction is the
 * whole point: it must answer "who depends on this file", never "what does this
 * file import". A test that only counted rows would pass with the arrow
 * backwards, so every case here pins direction explicitly.
 *
 * Integration rather than unit: the traversal is interleaved with indexed SQL
 * (one query per hop against `file_edges_repo_to_idx`), so mocking the query
 * builder would test the mock.
 */

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

let seq = 0;

d('RepoIntelRepository.getImporters (Testcontainers pg)', () => {
  let pg: PgFixture;
  let repository: RepoIntelRepository;
  let workspaceId: string;

  beforeAll(async () => {
    pg = await startPg();
    await seed(pg.handle.db);
    const [ws] = await pg.handle.db.select().from(t.workspaces);
    workspaceId = ws!.id;
    repository = new RepoIntelRepository(pg.handle.db);
  });
  afterAll(async () => {
    await pg?.stop();
  });

  /** Insert a repo plus its import graph. Each edge is `importer → imported`. */
  async function repoWithEdges(edges: [string, string][]) {
    const name = `importers-${seq++}`;
    const [repo] = await pg.handle.db
      .insert(t.repos)
      .values({ workspaceId, owner: 'acme', name, fullName: `acme/${name}` })
      .returning();
    if (edges.length > 0) {
      await pg.handle.db
        .insert(t.fileEdges)
        .values(edges.map(([fromFile, toFile]) => ({ repoId: repo!.id, fromFile, toFile })));
    }
    return repo!;
  }

  it('walks against the import arrow: dependents, not dependencies', async () => {
    // router imports helper; helper imports lodash.
    const repo = await repoWithEdges([
      ['src/router.ts', 'src/helper.ts'],
      ['src/helper.ts', 'src/lodash.ts'],
    ]);

    const reached = await repository.getImporters(repo.id, ['src/helper.ts'], 2);

    expect([...reached.keys()]).toEqual(['src/router.ts']);
    // The changed file's OWN dependency must never appear — that is the
    // direction bug this whole method exists to avoid.
    expect(reached.has('src/lodash.ts')).toBe(false);
  });

  it('reaches two hops and records the changed file each importer traces back to', async () => {
    const repo = await repoWithEdges([
      ['src/mid.ts', 'src/helper.ts'],
      ['src/top.ts', 'src/mid.ts'],
    ]);

    const reached = await repository.getImporters(repo.id, ['src/helper.ts'], 2);

    expect(reached.get('src/mid.ts')).toEqual({ fromFile: 'src/helper.ts', depth: 1 });
    expect(reached.get('src/top.ts')).toEqual({ fromFile: 'src/helper.ts', depth: 2 });
  });

  it('stops at the requested depth', async () => {
    const repo = await repoWithEdges([
      ['src/mid.ts', 'src/helper.ts'],
      ['src/top.ts', 'src/mid.ts'],
      ['src/tip.ts', 'src/top.ts'],
    ]);

    const reached = await repository.getImporters(repo.id, ['src/helper.ts'], 2);

    expect(reached.has('src/top.ts')).toBe(true);
    expect(reached.has('src/tip.ts')).toBe(false);
  });

  it('terminates on a cyclic graph and never re-expands a file', async () => {
    const repo = await repoWithEdges([
      ['src/a.ts', 'src/b.ts'],
      ['src/b.ts', 'src/a.ts'],
    ]);

    const reached = await repository.getImporters(repo.id, ['src/a.ts'], 2);

    // b imports a. a imports b, but a is a seed, so it is not "reached".
    expect([...reached.keys()]).toEqual(['src/b.ts']);
  });

  it('records the shallowest hop when a file is reachable two ways', async () => {
    const repo = await repoWithEdges([
      ['src/wide.ts', 'src/helper.ts'], // depth 1
      ['src/mid.ts', 'src/helper.ts'],
      ['src/wide.ts', 'src/mid.ts'], // would be depth 2
    ]);

    const reached = await repository.getImporters(repo.id, ['src/helper.ts'], 2);

    expect(reached.get('src/wide.ts')?.depth).toBe(1);
  });

  it('excludes every seed file, even when seeds import each other', async () => {
    const repo = await repoWithEdges([
      ['src/one.ts', 'src/two.ts'],
      ['src/outside.ts', 'src/two.ts'],
    ]);

    const reached = await repository.getImporters(repo.id, ['src/one.ts', 'src/two.ts'], 2);

    expect(reached.has('src/one.ts')).toBe(false);
    expect([...reached.keys()]).toEqual(['src/outside.ts']);
  });

  it('is scoped to its repo', async () => {
    const mine = await repoWithEdges([['src/router.ts', 'src/helper.ts']]);
    await repoWithEdges([['other/router.ts', 'src/helper.ts']]);

    const reached = await repository.getImporters(mine.id, ['src/helper.ts'], 2);

    expect([...reached.keys()]).toEqual(['src/router.ts']);
  });

  it('returns empty for no seeds, zero depth, or a repo with no graph', async () => {
    const repo = await repoWithEdges([]);
    expect((await repository.getImporters(repo.id, [], 2)).size).toBe(0);
    expect((await repository.getImporters(repo.id, ['src/a.ts'], 0)).size).toBe(0);
    // A partial index that skipped the graph step has no edges at all.
    expect((await repository.getImporters(repo.id, ['src/a.ts'], 2)).size).toBe(0);
  });
});
