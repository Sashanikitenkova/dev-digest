import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import { MockEmbedder, MockGitClient, MockGitHubClient, MockLLMProvider } from '../src/adapters/mocks.js';
import * as t from '../src/db/schema.js';

/**
 * Project-context module (SPEC-01), end to end against a real Postgres AND a
 * real filesystem clone.
 *
 * `ContextService.listDocuments`/`readDocument` do a LIVE fs walk over
 * `repos.clone_path` (`node:fs/promises`, not the `GitClient` port) — so unlike
 * most integration suites here, this one also builds a real temp directory on
 * disk per repo, matching what a synced clone looks like.
 *
 * Load-bearing assertions a unit test cannot make:
 *   • "not cloned" and "cloned with zero documents" are distinct listing states
 *   • reorder is not merely accepted — it round-trips through a fresh GET
 *   • attaching/detaching never touches agents.version / skills.version
 *   • one bad path in a submission persists NOTHING, not a partial set
 *   • the used-by-agents count is a DIRECT-attachment count, never via a skill
 */

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const config = () => loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);

async function writeFileAt(root: string, rel: string, contents: string): Promise<void> {
  const full = join(root, rel);
  const dir = full.slice(0, full.lastIndexOf('/'));
  if (dir && dir !== root) await mkdir(dir, { recursive: true });
  await writeFile(full, contents);
}

d('Project context module (Testcontainers pg + real fs clone)', () => {
  let pg: PgFixture;
  let workspaceId: string;
  let repoSeq = 0;
  let cloneRoots: string[] = [];

  beforeAll(async () => {
    pg = await startPg();
    await seed(pg.handle.db);
    const [ws] = await pg.handle.db.select().from(t.workspaces);
    workspaceId = ws!.id;
  });
  afterAll(async () => {
    await pg?.stop();
  });

  afterEach(async () => {
    await Promise.all(cloneRoots.map((r) => rm(r, { recursive: true, force: true })));
    cloneRoots = [];
  });

  function appWith() {
    return buildApp({
      config: config(),
      db: pg.handle.db,
      overrides: {
        embedder: new MockEmbedder(),
        github: new MockGitHubClient(),
        git: new MockGitClient(),
        llm: { openai: new MockLLMProvider('openai') as never, openrouter: new MockLLMProvider('openai') as never },
      },
    });
  }

  /** A repo row backed by a REAL temp directory (or `clonePath: null`). */
  async function repoWithClone(opts: { cloned: boolean } = { cloned: true }) {
    const name = `context-${repoSeq++}`;
    let clonePath: string | null = null;
    if (opts.cloned) {
      clonePath = await mkdtemp(join(tmpdir(), 'devdigest-context-it-'));
      cloneRoots.push(clonePath);
    }
    const [repo] = await pg.handle.db
      .insert(t.repos)
      .values({ workspaceId, owner: 'acme', name, fullName: `acme/${name}`, clonePath })
      .returning();
    return { repo: repo!, clonePath };
  }

  async function createAgent(a: import('fastify').FastifyInstance, name: string) {
    const res = await a.inject({
      method: 'POST',
      url: '/agents',
      payload: { name, provider: 'openai', model: 'gpt-4.1', system_prompt: 'You are a reviewer.' },
    });
    return res.json();
  }

  async function createSkill(a: import('fastify').FastifyInstance, name: string) {
    const res = await a.inject({
      method: 'POST',
      url: '/skills',
      payload: { name, type: 'custom', source: 'manual', body: '# rule\nAlways cite line numbers.' },
    });
    return res.json();
  }


  /* AC-17 lives in reviewer-core; this suite proves the SERIALIZES AS panel is
     fed by that same function rather than by markdown assembled here. The panel
     drifted once on paper already (SPEC-01 design review row 1: mockup 4
     promised `## Project specifications`), so what matters is that the heading,
     the per-document headings, their ORDER and the untrusted delimiters come
     back exactly as a run would emit them. */
  it('previews what an attachment set serializes to, with bodies elided', async () => {
    const a = await appWith();
    const { repo, clonePath } = await repoWithClone();
    await writeFileAt(clonePath!, 'specs/api.md', '# API contract\nNever break a public field.');
    await writeFileAt(clonePath!, 'docs/architecture.md', '# Architecture\napi/ must not import db/.');
    const skill = await createSkill(a, `serializes-${repoSeq}`);

    // Attachment ORDER is assembly order, so submit the non-alphabetical one.
    await a.inject({
      method: 'PUT',
      url: `/skills/${skill.id}/context`,
      payload: { paths: ['docs/architecture.md', 'specs/api.md'] },
    });

    const res = await a.inject({
      method: 'GET',
      url: `/skills/${skill.id}/context/preview?repo=${repo.id}`,
    });
    expect(res.statusCode).toBe(200);
    const preview = res.json();

    expect(preview.block.startsWith('## Project context\n')).toBe(true);
    expect(preview.block).toContain('### docs/architecture.md');
    expect(preview.block).toContain('### specs/api.md');
    expect(preview.block.indexOf('### docs/architecture.md')).toBeLessThan(
      preview.block.indexOf('### specs/api.md'),
    );
    // Each body stays inside its own labelled untrusted delimiter (AC-18).
    expect(preview.block).toContain('<untrusted source="spec:docs/architecture.md">');
    expect(preview.block).toContain('<untrusted source="spec:specs/api.md">');
    // Elided: the structure is real, the content is not shipped to the editor.
    expect(preview.block).toContain('body elided');
    expect(preview.block).not.toContain('api/ must not import db/.');

    expect(preview.documents).toHaveLength(2);
    expect(preview.documents.every((d: { status: string }) => d.status === 'used')).toBe(true);
    expect(preview.total_tokens).toBeGreaterThan(0);
  });

  it('reports an attachment missing from the clone instead of dropping it silently', async () => {
    const a = await appWith();
    const { repo, clonePath } = await repoWithClone();
    await writeFileAt(clonePath!, 'specs/api.md', '# API contract\nNever break a public field.');
    await writeFileAt(clonePath!, 'docs/gone.md', '# doomed');
    const skill = await createSkill(a, `missing-${repoSeq}`);
    await a.inject({
      method: 'PUT',
      url: `/skills/${skill.id}/context`,
      payload: { paths: ['specs/api.md', 'docs/gone.md'] },
    });

    // Renamed/deleted in the repo after it was attached (EC-3).
    await rm(join(clonePath!, 'docs/gone.md'));

    const preview = (
      await a.inject({
        method: 'GET',
        url: `/skills/${skill.id}/context/preview?repo=${repo.id}`,
      })
    ).json();

    // Absent from the block — nothing unreadable reaches a model...
    expect(preview.block).not.toContain('docs/gone.md');
    expect(preview.block).toContain('### specs/api.md');
    // ...but still visible in the ledger, with the reason (AC-20/AC-23).
    const gone = preview.documents.find((d: { path: string }) => d.path === 'docs/gone.md');
    expect(gone.status).toBe('missing');
    expect(gone.reason).toBe('not_in_clone');
  });

  it('returns an empty block rather than a bare heading when nothing is attached', async () => {
    const a = await appWith();
    const { repo, clonePath } = await repoWithClone();
    await writeFileAt(clonePath!, 'specs/api.md', '# API contract');
    const skill = await createSkill(a, `empty-${repoSeq}`);

    const preview = (
      await a.inject({
        method: 'GET',
        url: `/skills/${skill.id}/context/preview?repo=${repo.id}`,
      })
    ).json();

    expect(preview.block).toBe('');
    expect(preview.documents).toEqual([]);
    expect(preview.total_tokens).toBe(0);
  });

  it('discovers documents by a live walk over the clone, describing each with path/type/bytes/tokens', async () => {
    const a = await appWith();
    const { repo, clonePath } = await repoWithClone();
    await writeFileAt(clonePath!, 'specs/api.md', '# API contract\nNever break a public field.');
    await writeFileAt(clonePath!, 'docs/architecture.md', '# Architecture\nThe api/ module must not import db/ directly.');
    // Not under a configured root — must not appear.
    await writeFileAt(clonePath!, 'src/notes.md', '# scratch notes');

    const res = await a.inject({ method: 'GET', url: `/repos/${repo.id}/context` });
    expect(res.statusCode).toBe(200);
    const listing = res.json();

    expect(listing.cloned).toBe(true);
    expect(listing.roots).toEqual(['specs', 'docs', 'insights']);
    const paths = listing.files.map((f: { path: string }) => f.path).sort();
    expect(paths).toEqual(['docs/architecture.md', 'specs/api.md']);

    const spec = listing.files.find((f: { path: string }) => f.path === 'specs/api.md');
    expect(spec.type).toBe('specs');
    expect(spec.bytes).toBeGreaterThan(0);
    expect(spec.tokens).toBeGreaterThan(0);
    // AC-6: the listing carries metadata only — no document content.
    expect(spec.content).toBeUndefined();

    await a.close();
  });

  it('distinguishes "not cloned" from "cloned but no documents" — two different listing states', async () => {
    const a = await appWith();

    const { repo: notCloned } = await repoWithClone({ cloned: false });
    const notClonedRes = (await a.inject({ method: 'GET', url: `/repos/${notCloned.id}/context` })).json();
    expect(notClonedRes.cloned).toBe(false);
    expect(notClonedRes.files).toEqual([]);

    // Cloned, but the configured roots are simply empty.
    const { repo: emptyRepo } = await repoWithClone({ cloned: true });
    const emptyRes = (await a.inject({ method: 'GET', url: `/repos/${emptyRepo.id}/context` })).json();
    expect(emptyRes.cloned).toBe(true);
    expect(emptyRes.files).toEqual([]);

    await a.close();
  });

  it('reorder persists and round-trips through a fresh GET (AC-9)', async () => {
    const a = await appWith();
    const { repo, clonePath } = await repoWithClone();
    await writeFileAt(clonePath!, 'docs/a.md', '# A');
    await writeFileAt(clonePath!, 'docs/b.md', '# B');
    const agent = await createAgent(a, 'Context Reviewer');

    const first = await a.inject({
      method: 'PUT',
      url: `/agents/${agent.id}/context`,
      payload: { paths: ['docs/a.md', 'docs/b.md'] },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().paths).toEqual(['docs/a.md', 'docs/b.md']);

    const reordered = await a.inject({
      method: 'PUT',
      url: `/agents/${agent.id}/context`,
      payload: { paths: ['docs/b.md', 'docs/a.md'] },
    });
    expect(reordered.json().paths).toEqual(['docs/b.md', 'docs/a.md']);

    // A FRESH GET — not just the PUT's own response — proves it was persisted,
    // not merely echoed back.
    const roundTrip = await a.inject({ method: 'GET', url: `/agents/${agent.id}/context` });
    expect(roundTrip.json().paths).toEqual(['docs/b.md', 'docs/a.md']);

    await a.close();
  });

  it('attaching then detaching leaves agents.version and skills.version untouched (AC-11)', async () => {
    const a = await appWith();
    const { clonePath } = await repoWithClone();
    await writeFileAt(clonePath!, 'docs/a.md', '# A');
    const agent = await createAgent(a, 'Version Guard Agent');
    const skill = await createSkill(a, 'version-guard-skill');

    expect(agent.version).toBe(1);
    expect(skill.version).toBe(1);

    // Creating an agent already writes its own initial `agent_versions` row —
    // capture that baseline so the assertion below is about whether ATTACHING
    // context adds a NEW row, not about whether any row exists at all.
    const versionsBeforeAttach = await pg.handle.db
      .select()
      .from(t.agentVersions)
      .where(eq(t.agentVersions.agentId, agent.id));

    await a.inject({
      method: 'PUT',
      url: `/agents/${agent.id}/context`,
      payload: { paths: ['docs/a.md'] },
    });
    await a.inject({
      method: 'PUT',
      url: `/skills/${skill.id}/context`,
      payload: { paths: ['docs/a.md'] },
    });

    const [agentRowAfterAttach] = await pg.handle.db
      .select()
      .from(t.agents)
      .where(eq(t.agents.id, agent.id));
    const [skillRowAfterAttach] = await pg.handle.db
      .select()
      .from(t.skills)
      .where(eq(t.skills.id, skill.id));
    expect(agentRowAfterAttach!.version).toBe(1);
    expect(skillRowAfterAttach!.version).toBe(1);

    // Detach (replace with an empty set) — still no version bump.
    await a.inject({ method: 'PUT', url: `/agents/${agent.id}/context`, payload: { paths: [] } });
    await a.inject({ method: 'PUT', url: `/skills/${skill.id}/context`, payload: { paths: [] } });

    const [agentRowAfterDetach] = await pg.handle.db
      .select()
      .from(t.agents)
      .where(eq(t.agents.id, agent.id));
    const [skillRowAfterDetach] = await pg.handle.db
      .select()
      .from(t.skills)
      .where(eq(t.skills.id, skill.id));
    expect(agentRowAfterDetach!.version).toBe(1);
    expect(skillRowAfterDetach!.version).toBe(1);

    // No NEW version-history row was written by attach or detach.
    const agentVersionsAfter = await pg.handle.db
      .select()
      .from(t.agentVersions)
      .where(eq(t.agentVersions.agentId, agent.id));
    expect(agentVersionsAfter).toHaveLength(versionsBeforeAttach.length);

    await a.close();
  });

  it('a submission with one bad path rejects the WHOLE submission and persists nothing (AC-10)', async () => {
    const a = await appWith();
    const { clonePath } = await repoWithClone();
    await writeFileAt(clonePath!, 'docs/a.md', '# A');
    const agent = await createAgent(a, 'Rejects Bad Paths');

    const res = await a.inject({
      method: 'PUT',
      url: `/agents/${agent.id}/context`,
      payload: { paths: ['docs/a.md', '../../etc/passwd.md'] },
    });
    expect(res.statusCode).toBe(422);

    const after = await a.inject({ method: 'GET', url: `/agents/${agent.id}/context` });
    expect(after.json().paths).toEqual([]);

    await a.close();
  });

  it('rejects a non-.md path in a submission the same way', async () => {
    const a = await appWith();
    const { clonePath } = await repoWithClone();
    await writeFileAt(clonePath!, 'docs/a.md', '# A');
    const agent = await createAgent(a, 'Rejects Non-md');

    const res = await a.inject({
      method: 'PUT',
      url: `/agents/${agent.id}/context`,
      payload: { paths: ['docs/a.md', 'docs/notes.txt'] },
    });
    expect(res.statusCode).toBe(422);

    const after = await a.inject({ method: 'GET', url: `/agents/${agent.id}/context` });
    expect(after.json().paths).toEqual([]);

    await a.close();
  });

  it('used_by_agents counts DIRECT agent attachments only, never a skill-inherited one (AC-38)', async () => {
    const a = await appWith();
    const { repo, clonePath } = await repoWithClone();
    await writeFileAt(clonePath!, 'docs/direct.md', '# attached directly');
    await writeFileAt(clonePath!, 'docs/via-skill.md', '# attached only through a skill');

    const directAgent = await createAgent(a, 'Direct Attacher');
    await a.inject({
      method: 'PUT',
      url: `/agents/${directAgent.id}/context`,
      payload: { paths: ['docs/direct.md'] },
    });

    const skill = await createSkill(a, 'inherits-context');
    await a.inject({
      method: 'PUT',
      url: `/skills/${skill.id}/context`,
      payload: { paths: ['docs/via-skill.md'] },
    });
    const skillLinker = await createAgent(a, 'Skill Linker');
    await a.inject({
      method: 'POST',
      url: `/agents/${skillLinker.id}/skills`,
      payload: { skill_ids: [skill.id] },
    });

    const listing = (await a.inject({ method: 'GET', url: `/repos/${repo.id}/context` })).json();
    const direct = listing.files.find((f: { path: string }) => f.path === 'docs/direct.md');
    const viaSkill = listing.files.find((f: { path: string }) => f.path === 'docs/via-skill.md');

    expect(direct.used_by_agents).toBe(1);
    // The skill IS linked to an agent, yet the document was never attached to
    // that agent directly — the count must stay 0.
    expect(viaSkill.used_by_agents).toBe(0);

    await a.close();
  });

  it('one document\'s body is served for the read-only preview, distinct from the listing', async () => {
    const a = await appWith();
    const { repo, clonePath } = await repoWithClone();
    await writeFileAt(clonePath!, 'docs/architecture.md', '# Architecture\nRule text here.');

    const res = await a.inject({
      method: 'GET',
      url: `/repos/${repo.id}/context/file?path=${encodeURIComponent('docs/architecture.md')}`,
    });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.path).toBe('docs/architecture.md');
    expect(doc.content).toContain('Rule text here.');

    await a.close();
  });

  /* Concurrency. `replace` is delete-then-insert; without a FOR UPDATE lock on
     the owner, two overlapping requests interleave — T2's DELETE evaluates
     against the pre-T1 snapshot and removes nothing, then T2's INSERT collides
     with the row T1 just committed:

       duplicate key value violates unique constraint
       "skill_context_files_skill_id_path_pk"

     which reached the user as a red HTTP 500 after two quick clicks. */
  it('survives two concurrent replaces of the SAME skill (no duplicate-key 500)', async () => {
    const a = await appWith();
    const skill = await createSkill(a, `race-skill-${repoSeq++}`);

    const setA = ['docs/architecture.md', 'specs/api.md'];
    const setB = ['docs/architecture.md', 'insights/lessons.md'];
    // The overlapping path is what collides: both submissions insert it.
    const [r1, r2] = await Promise.all([
      a.inject({ method: 'PUT', url: `/skills/${skill.id}/context`, payload: { paths: setA } }),
      a.inject({ method: 'PUT', url: `/skills/${skill.id}/context`, payload: { paths: setB } }),
    ]);

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);

    // Either submission may win — but the result must be exactly ONE of them,
    // never a merged or partial set.
    const after = (await a.inject({ method: 'GET', url: `/skills/${skill.id}/context` })).json();
    expect([setA, setB]).toContainEqual(after.paths);
  });

  it('survives two concurrent replaces of the SAME agent', async () => {
    const a = await appWith();
    const agent = await createAgent(a, `race-agent-${repoSeq++}`);

    const setA = ['specs/api.md'];
    const setB = ['specs/api.md', 'docs/architecture.md'];
    const [r1, r2] = await Promise.all([
      a.inject({ method: 'PUT', url: `/agents/${agent.id}/context`, payload: { paths: setA } }),
      a.inject({ method: 'PUT', url: `/agents/${agent.id}/context`, payload: { paths: setB } }),
    ]);

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    const after = (await a.inject({ method: 'GET', url: `/agents/${agent.id}/context` })).json();
    expect([setA, setB]).toContainEqual(after.paths);
  });

  it('does not serialize writes to DIFFERENT owners', async () => {
    // The lock is per ROW: two different agents must both land their own set,
    // which also proves the fix did not turn this into a table-wide bottleneck.
    const a = await appWith();
    const one = await createAgent(a, `par-agent-a-${repoSeq++}`);
    const two = await createAgent(a, `par-agent-b-${repoSeq++}`);

    await Promise.all([
      a.inject({ method: 'PUT', url: `/agents/${one.id}/context`, payload: { paths: ['specs/api.md'] } }),
      a.inject({ method: 'PUT', url: `/agents/${two.id}/context`, payload: { paths: ['docs/architecture.md'] } }),
    ]);

    const afterOne = (await a.inject({ method: 'GET', url: `/agents/${one.id}/context` })).json();
    const afterTwo = (await a.inject({ method: 'GET', url: `/agents/${two.id}/context` })).json();
    expect(afterOne.paths).toEqual(['specs/api.md']);
    expect(afterTwo.paths).toEqual(['docs/architecture.md']);
  });

});
