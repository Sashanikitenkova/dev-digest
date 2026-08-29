import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';
import { MockGitClient, MockGitHubClient } from '../src/adapters/mocks.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

if (!hasDocker) {
  // eslint-disable-next-line no-console
  console.warn('[skills-stats] Docker not available — skipping integration tests.');
}

/**
 * The Skills Lab stats read-model, exercised through HTTP.
 *
 * The fixture writes runs, traces, reviews and findings directly rather than
 * driving a real review: the numbers under test are aggregations, and a live
 * review would make the expected values depend on a mock LLM's output.
 *
 * The load-bearing case is `pull_frequency`. Nothing links a run to a skill, so
 * the query looks for `### <name>` inside the trace's assembled skills block —
 * exactly the heading `formatSkillBlocks` writes. One run below therefore
 * carries the heading and one deliberately does not.
 */
d('skills stats', () => {
  let pg: PgFixture;
  let workspaceId: string;
  let prId: string;

  beforeAll(async () => {
    pg = await startPg();
    await seed(pg.handle.db);
    const { db } = pg.handle;

    const [ws] = await db
      .select({ id: t.workspaces.id })
      .from(t.workspaces)
      .where(eq(t.workspaces.name, 'default'));
    workspaceId = ws!.id;

    const [repo] = await db
      .insert(t.repos)
      .values({ workspaceId, owner: 'acme', name: 'stats-api', fullName: 'acme/stats-api' })
      .returning();
    const [pr] = await db
      .insert(t.pullRequests)
      .values({
        workspaceId,
        repoId: repo!.id,
        number: 1,
        title: 'Stats fixture',
        author: 'tester',
        branch: 'feat/stats',
        base: 'main',
        headSha: 'deadbeef',
        additions: 1,
        deletions: 0,
        filesCount: 1,
        status: 'needs_review',
      })
      .returning();
    prId = pr!.id;
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

  /** A run plus its trace. `pulledSkill` decides whether the block was injected. */
  async function addRun(agentId: string, pulledSkill: string | null, ranAt = new Date()) {
    const { db } = pg.handle;
    const [run] = await db
      .insert(t.agentRuns)
      .values({ workspaceId, agentId, prId, ranAt, status: 'succeeded' })
      .returning();
    await db.insert(t.runTraces).values({
      runId: run!.id,
      trace: {
        prompt_assembly: {
          system: 'You are a reviewer.',
          skills: pulledSkill ? `### ${pulledSkill}\nbody` : null,
          user: 'Review this.',
        },
      },
    });
    return run!.id;
  }

  /** A review with findings. Each tuple is [category, 'accepted'|'dismissed'|null]. */
  async function addReview(
    agentId: string,
    findings: [string, 'accepted' | 'dismissed' | null][],
    createdAt = new Date(),
  ) {
    const { db } = pg.handle;
    const [review] = await db
      .insert(t.reviews)
      .values({ workspaceId, prId, agentId, kind: 'review', createdAt })
      .returning();
    for (const [category, triage] of findings) {
      await db.insert(t.findings).values({
        reviewId: review!.id,
        file: 'src/a.ts',
        startLine: 1,
        endLine: 1,
        severity: 'WARNING',
        category,
        title: `${category} finding`,
        rationale: 'because',
        confidence: 0.9,
        ...(triage === 'accepted' ? { acceptedAt: new Date() } : {}),
        ...(triage === 'dismissed' ? { dismissedAt: new Date() } : {}),
      });
    }
  }

  async function makeAgent(app: Awaited<ReturnType<typeof makeApp>>, name: string) {
    return (
      await app.inject({
        method: 'POST',
        url: '/agents',
        payload: { name, provider: 'openai', model: 'gpt-4o-mini', system_prompt: 'Review.' },
      })
    ).json().id as string;
  }

  async function makeSkill(app: Awaited<ReturnType<typeof makeApp>>, name: string) {
    return (
      await app.inject({
        method: 'POST',
        url: '/skills',
        payload: { name, description: 'd', type: 'rubric', body: `# ${name}` },
      })
    ).json().id as string;
  }

  it('counts linked agents, pull frequency, accept rate and findings', async () => {
    const app = await makeApp();
    const skillId = await makeSkill(app, 'stats-rubric');
    const agentA = await makeAgent(app, 'Stats Reviewer A');
    const agentB = await makeAgent(app, 'Stats Reviewer B');

    await app.inject({
      method: 'POST',
      url: `/agents/${agentA}/skills`,
      payload: { skill_ids: [skillId] },
    });
    await app.inject({
      method: 'POST',
      url: `/agents/${agentB}/skills`,
      payload: { skill_ids: [skillId] },
    });

    // 3 traced runs across the two linking agents; 2 actually pulled the block.
    await addRun(agentA, 'stats-rubric');
    await addRun(agentA, null);
    await addRun(agentB, 'stats-rubric');

    // 4 findings: 2 accepted, 1 dismissed, 1 untriaged.
    await addReview(agentA, [
      ['security', 'accepted'],
      ['security', 'accepted'],
      ['bug', 'dismissed'],
      ['perf', null],
    ]);

    const res = await app.inject({ method: 'GET', url: `/skills/${skillId}/stats` });
    expect(res.statusCode).toBe(200);
    const stats = res.json();

    expect(stats.used_by_agents).toBe(2);
    expect(stats.linked_agents).toBe(2);
    expect(stats.pull_frequency).toBeCloseTo(2 / 3, 5);
    // Untriaged findings count toward neither side of the rate.
    expect(stats.accept_rate).toBeCloseTo(2 / 3, 5);
    expect(stats.findings_30d).toBe(4);
    expect(stats.findings_by_category).toEqual([
      { category: 'security', count: 2 },
      { category: 'bug', count: 1 },
      { category: 'perf', count: 1 },
    ]);
    expect(stats.agents.map((a: { name: string }) => a.name)).toEqual([
      'Stats Reviewer A',
      'Stats Reviewer B',
    ]);
    await app.close();
  });

  it('reports null — not zero — when there is no evidence either way', async () => {
    const app = await makeApp();
    const skillId = await makeSkill(app, 'never-used');

    const stats = (await app.inject({ method: 'GET', url: `/skills/${skillId}/stats` })).json();
    // "No run has used this" is a different fact from "offered and never pulled".
    expect(stats.pull_frequency).toBeNull();
    expect(stats.accept_rate).toBeNull();
    expect(stats.used_by_agents).toBe(0);
    expect(stats.findings_30d).toBe(0);
    expect(stats.findings_by_category).toEqual([]);
    expect(stats.agents).toEqual([]);
    await app.close();
  });

  it('reports 0 accept rate when everything was dismissed', async () => {
    const app = await makeApp();
    const skillId = await makeSkill(app, 'all-rejected');
    const agentId = await makeAgent(app, 'Rejector');
    await app.inject({
      method: 'POST',
      url: `/agents/${agentId}/skills`,
      payload: { skill_ids: [skillId] },
    });
    await addReview(agentId, [
      ['style', 'dismissed'],
      ['style', 'dismissed'],
    ]);

    const stats = (await app.inject({ method: 'GET', url: `/skills/${skillId}/stats` })).json();
    expect(stats.accept_rate).toBe(0);
    await app.close();
  });

  it('a disabled link still lists the agent but stops counting it as a user', async () => {
    const app = await makeApp();
    const skillId = await makeSkill(app, 'link-toggled');
    const agentId = await makeAgent(app, 'Toggler');
    await app.inject({
      method: 'POST',
      url: `/agents/${agentId}/skills`,
      payload: { skill_ids: [skillId] },
    });
    await app.inject({
      method: 'PUT',
      url: `/agents/${agentId}/skills/${skillId}`,
      payload: { enabled: false },
    });

    const stats = (await app.inject({ method: 'GET', url: `/skills/${skillId}/stats` })).json();
    expect(stats.used_by_agents).toBe(0);
    // The link still exists and is still worth showing — it just isn't active.
    expect(stats.linked_agents).toBe(1);
    expect(stats.agents).toHaveLength(1);
    await app.close();
  });

  it('excludes activity older than the 30-day window', async () => {
    const app = await makeApp();
    const skillId = await makeSkill(app, 'stale-only');
    const agentId = await makeAgent(app, 'Historian');
    await app.inject({
      method: 'POST',
      url: `/agents/${agentId}/skills`,
      payload: { skill_ids: [skillId] },
    });

    const longAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    await addRun(agentId, 'stale-only', longAgo);
    await addReview(agentId, [['bug', 'accepted']], longAgo);

    const stats = (await app.inject({ method: 'GET', url: `/skills/${skillId}/stats` })).json();
    expect(stats.pull_frequency).toBeNull();
    expect(stats.accept_rate).toBeNull();
    expect(stats.findings_30d).toBe(0);
    await app.close();
  });

  it('GET /skills/stats returns one compact row per skill', async () => {
    const app = await makeApp();
    const skillId = await makeSkill(app, 'batch-listed');

    const rows = (await app.inject({ method: 'GET', url: '/skills/stats' })).json();
    const skills = (await app.inject({ method: 'GET', url: '/skills' })).json();
    // Every skill gets a row, including ones nothing has touched — an absent
    // row would make the card silently drop its footer.
    expect(rows).toHaveLength(skills.length);
    const mine = rows.find((r: { skill_id: string }) => r.skill_id === skillId);
    expect(mine).toEqual({
      skill_id: skillId,
      used_by_agents: 0,
      pull_frequency: null,
      accept_rate: null,
    });
    await app.close();
  });

  it('is workspace-scoped: another tenant never appears in the numbers', async () => {
    const { db } = pg.handle;
    const app = await makeApp();
    const skillId = await makeSkill(app, 'tenant-isolated');
    const agentId = await makeAgent(app, 'Mine');
    await app.inject({
      method: 'POST',
      url: `/agents/${agentId}/skills`,
      payload: { skill_ids: [skillId] },
    });

    const [otherWs] = await db.insert(t.workspaces).values({ name: 'stats-other' }).returning();
    const [foreignAgent] = await db
      .insert(t.agents)
      .values({
        workspaceId: otherWs!.id,
        name: 'Theirs',
        provider: 'openai',
        model: 'gpt-4o-mini',
        systemPrompt: 'Review.',
      })
      .returning();
    // Same skill id, an agent in a different workspace: the link table has no
    // workspace column, so only the join to `agents` keeps tenants apart.
    await db.insert(t.agentSkills).values({ agentId: foreignAgent!.id, skillId, order: 0 });

    const stats = (await app.inject({ method: 'GET', url: `/skills/${skillId}/stats` })).json();
    expect(stats.agents.map((a: { name: string }) => a.name)).toEqual(['Mine']);
    expect(stats.used_by_agents).toBe(1);

    // And the foreign workspace cannot read this skill's stats at all.
    const foreignSkill = await db
      .select({ id: t.skills.id })
      .from(t.skills)
      .where(and(eq(t.skills.workspaceId, otherWs!.id), eq(t.skills.id, skillId)));
    expect(foreignSkill).toHaveLength(0);
    await app.close();
  });

  it('GET /agents carries a skills_count that follows both enabled switches', async () => {
    const app = await makeApp();
    const agentId = await makeAgent(app, 'Counted');
    const onSkill = await makeSkill(app, 'count-on');
    const offLink = await makeSkill(app, 'count-off-link');
    const offSkill = await makeSkill(app, 'count-off-skill');

    await app.inject({
      method: 'POST',
      url: `/agents/${agentId}/skills`,
      payload: { skill_ids: [onSkill, offLink, offSkill] },
    });
    // One link switched off, one skill switched off — each must drop the count.
    await app.inject({
      method: 'PUT',
      url: `/agents/${agentId}/skills/${offLink}`,
      payload: { enabled: false },
    });
    await app.inject({ method: 'PUT', url: `/skills/${offSkill}`, payload: { enabled: false } });

    const agents = (await app.inject({ method: 'GET', url: '/agents' })).json();
    const mine = agents.find((a: { id: string }) => a.id === agentId);
    expect(mine.skills_count).toBe(1);

    // An agent with no links reports 0 rather than omitting the field.
    const bare = await makeAgent(app, 'Unlinked');
    const after = (await app.inject({ method: 'GET', url: '/agents' })).json();
    expect(after.find((a: { id: string }) => a.id === bare).skills_count).toBe(0);
    await app.close();
  });
});
