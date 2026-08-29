import 'dotenv/config';
import { createDb, type Db } from './client.js';
import * as t from './schema.js';
import { eq, and } from 'drizzle-orm';
import {
  GENERAL_REVIEWER_PROMPT,
  SECURITY_REVIEWER_PROMPT,
  PERFORMANCE_REVIEWER_PROMPT,
  TEST_QUALITY_REVIEWER_PROMPT,
  API_CONTRACT_REVIEWER_PROMPT,
  TEST_COVERAGE_NUDGE_SKILL,
  FLAKY_TEST_PATTERNS_SKILL,
  API_CONTRACT_GUARD_SKILL,
  VENDORED_CONTRACT_SYNC_SKILL,
  PR_QUALITY_RUBRIC_SKILL,
} from './seed-prompts.js';

/** Default provider/model for the built-in reviewer agents. */
const DEFAULT_PROVIDER = 'openrouter' as const;
const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash';

/**
 * Seed the starter's demo data. Idempotent: re-running upserts the default
 * workspace/user and the demo fixtures.
 *
 * Seeds: default workspace + system user + membership, default settings,
 * demo repo (acme/payments-api), PR #482 with files/commits, a sample review
 * with a few findings, the five built-in agents (General + Security +
 * Performance + Test Quality + API Contract), all on the default
 * openrouter/deepseek-v4-flash provider+model, and the reusable skills those
 * agents link to.
 *
 * Course lessons populate the other tables (conventions, memory, eval, …) once
 * their features are built — they start empty here.
 */

export const DEFAULT_WORKSPACE_NAME = 'default';
export const SYSTEM_USER_EMAIL = 'you@local';

export async function seed(db: Db): Promise<{ workspaceId: string; userId: string }> {
  // ---- workspace + user (no-auth defaults) ----
  let [ws] = await db
    .select()
    .from(t.workspaces)
    .where(eq(t.workspaces.name, DEFAULT_WORKSPACE_NAME));
  if (!ws) {
    [ws] = await db
      .insert(t.workspaces)
      .values({ name: DEFAULT_WORKSPACE_NAME })
      .returning();
  }
  const workspaceId = ws!.id;

  let [user] = await db.select().from(t.users).where(eq(t.users.email, SYSTEM_USER_EMAIL));
  if (!user) {
    [user] = await db
      .insert(t.users)
      .values({ email: SYSTEM_USER_EMAIL, name: 'You' })
      .returning();
  }
  const userId = user!.id;

  await db
    .insert(t.workspaceMembers)
    .values({ workspaceId, userId, role: 'owner' })
    .onConflictDoNothing();

  // ---- default settings ----
  const defaultSettings: Record<string, unknown> = {
    polling_interval_min: 5,
    theme: 'dark',
    density: 'regular',
    sync_to_folder: true,
  };
  for (const [key, value] of Object.entries(defaultSettings)) {
    await db
      .insert(t.settings)
      .values({ workspaceId, userId, key, value })
      .onConflictDoNothing();
  }

  // ---- demo repo (acme/payments-api) ----
  let [repo] = await db
    .select()
    .from(t.repos)
    .where(and(eq(t.repos.workspaceId, workspaceId), eq(t.repos.fullName, 'acme/payments-api')));
  if (!repo) {
    [repo] = await db
      .insert(t.repos)
      .values({
        workspaceId,
        owner: 'acme',
        name: 'payments-api',
        fullName: 'acme/payments-api',
        defaultBranch: 'main',
        clonePath: null,
        createdBy: userId,
      })
      .returning();
  }
  const repoId = repo!.id;

  // ---- PR #482 (rate limiting) ----
  let [pr] = await db
    .select()
    .from(t.pullRequests)
    .where(and(eq(t.pullRequests.repoId, repoId), eq(t.pullRequests.number, 482)));
  if (!pr) {
    [pr] = await db
      .insert(t.pullRequests)
      .values({
        workspaceId,
        repoId,
        number: 482,
        title: 'Add rate limiting to public API endpoints',
        author: 'marisa.koch',
        branch: 'feat/rate-limit-public',
        base: 'main',
        headSha: 'a1b2c3d4e5f6',
        additions: 247,
        deletions: 38,
        filesCount: 9,
        status: 'needs_review',
        body: 'Add rate limiting to public API endpoints to prevent abuse from unauthenticated clients.',
      })
      .returning();

    // pr_files (subset)
    await db.insert(t.prFiles).values([
      { prId: pr!.id, path: 'src/middleware/ratelimit.ts', additions: 84, deletions: 0 },
      { prId: pr!.id, path: 'src/api/public/webhooks.ts', additions: 31, deletions: 6 },
      { prId: pr!.id, path: 'src/config.ts', additions: 4, deletions: 0 },
      { prId: pr!.id, path: 'src/api/users.ts', additions: 7, deletions: 2 },
    ]);

    // pr_commits
    await db.insert(t.prCommits).values({
      prId: pr!.id,
      sha: 'a1b2c3d4e5f6',
      message: 'Add token-bucket rate limiter',
      author: 'marisa.koch',
    });

    // a sample review + findings so the PR shows results before the first run
    const [review] = await db
      .insert(t.reviews)
      .values({
        workspaceId,
        prId: pr!.id,
        kind: 'review',
        verdict: 'request_changes',
        summary:
          'Solid middleware approach, but a Stripe secret key is committed in plaintext and the user-list endpoint introduces an N+1 query under the new limiter.',
        score: 61,
        model: 'seed',
      })
      .returning();

    await db.insert(t.findings).values([
      {
        reviewId: review!.id,
        file: 'src/config.ts',
        startLine: 12,
        endLine: 12,
        severity: 'CRITICAL',
        category: 'security',
        title: 'Hardcoded Stripe secret key in commit',
        rationale: 'Line 12 contains a literal `sk_live_` Stripe secret key.',
        suggestion: 'Move to env var and rotate the key immediately.',
        confidence: 0.98,
      },
      {
        reviewId: review!.id,
        file: 'src/api/users.ts',
        startLine: 45,
        endLine: 52,
        severity: 'WARNING',
        category: 'perf',
        title: 'N+1 query in user list endpoint',
        rationale: 'Loop issues one query per user → N+1.',
        suggestion: 'Use a single IN query and group in memory.',
        confidence: 0.86,
      },
    ]);
  }

  // ---- built-in agents (the starter presets) ----
  // Prompt bodies live in ./seed-prompts.ts (mirrored in docs/agent-prompts/*.md).
  const seedAgents: Array<typeof t.agents.$inferInsert> = [
    {
      workspaceId,
      name: 'General Reviewer',
      description: 'Reviews a PR diff for bugs, correctness, and clarity.',
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
      systemPrompt: GENERAL_REVIEWER_PROMPT,
      enabled: true,
      version: 1,
      createdBy: userId,
    },
    {
      workspaceId,
      name: 'Security Reviewer',
      description: 'Flags secrets, injection, SSRF and the lethal trifecta before merge.',
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
      systemPrompt: SECURITY_REVIEWER_PROMPT,
      enabled: true,
      version: 1,
      createdBy: userId,
    },
    {
      workspaceId,
      name: 'Performance Reviewer',
      description: 'Catches N+1 queries, missing indexes, and hot-path allocations.',
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
      systemPrompt: PERFORMANCE_REVIEWER_PROMPT,
      enabled: true,
      version: 1,
      createdBy: userId,
    },
    {
      workspaceId,
      name: 'Test Quality Reviewer',
      description:
        'Judges the tests: uncovered branches, missing corner cases, over-mocking, flaky patterns.',
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
      systemPrompt: TEST_QUALITY_REVIEWER_PROMPT,
      enabled: true,
      version: 1,
      createdBy: userId,
    },
    {
      workspaceId,
      name: 'API Contract Reviewer',
      description:
        'Catches breaking changes to routes, schemas, and exported function signatures.',
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
      systemPrompt: API_CONTRACT_REVIEWER_PROMPT,
      enabled: true,
      version: 1,
      createdBy: userId,
    },
  ];
  const agentIdByName = new Map<string, string>();
  for (const a of seedAgents) {
    let [existing] = await db
      .select()
      .from(t.agents)
      .where(and(eq(t.agents.workspaceId, workspaceId), eq(t.agents.name, a.name)));
    if (!existing) [existing] = await db.insert(t.agents).values(a).returning();
    agentIdByName.set(a.name, existing!.id);
  }

  // ---- reusable skills + agent links ----
  // Deliberately OUTSIDE the `if (!pr)` guard above: that block is skipped on a
  // re-seed once PR #482 exists, so anything nested in it would silently never
  // land on an existing DB (see server/INSIGHTS.md, 2026-06-27). This section is
  // idempotent on its own — insert-if-absent by name, `onConflictDoNothing` on
  // the version snapshot and the agent link (both have composite PKs).
  //
  // `source` drives the trust boundary at review time: a 'manual' body is
  // injected as trusted instructions, while 'community' / 'imported_url' /
  // 'extracted' bodies are wrapped in `<untrusted source="skill:…">` and passed
  // to the model as data. `flaky-test-patterns` is seeded as 'community' so that
  // wrapping is demonstrable end-to-end without importing anything by hand.
  const seedSkills: Array<Omit<typeof t.skills.$inferInsert, 'workspaceId'>> = [
    {
      name: 'test-coverage-nudge',
      description:
        'Demand a test for every branch this diff adds, and name the input that reaches it.',
      type: 'custom',
      source: 'manual',
      body: TEST_COVERAGE_NUDGE_SKILL,
      enabled: true,
      version: 1,
    },
    {
      name: 'flaky-test-patterns',
      description:
        'Flag sleeps, real clocks, unseeded randomness, order dependence, and volatile snapshots in tests.',
      type: 'convention',
      source: 'community',
      body: FLAKY_TEST_PATTERNS_SKILL,
      enabled: true,
      version: 1,
    },
    {
      name: 'api-contract-guard',
      description:
        'Classify each changed contract as additive or breaking, and name the consumer that breaks.',
      type: 'rubric',
      source: 'manual',
      body: API_CONTRACT_GUARD_SKILL,
      enabled: true,
      version: 1,
    },
    {
      name: 'vendored-contract-sync',
      description:
        'Require an edit under vendor/shared/ to appear in both the server and client copies.',
      type: 'convention',
      source: 'manual',
      body: VENDORED_CONTRACT_SYNC_SKILL,
      enabled: true,
      version: 1,
    },
    {
      name: 'pr-quality-rubric',
      description:
        'Hold every finding to the same bar: introduced here, mechanism named, cited, distinct, actionable.',
      type: 'rubric',
      source: 'manual',
      body: PR_QUALITY_RUBRIC_SKILL,
      enabled: true,
      version: 1,
    },
  ];

  const skillIdByName = new Map<string, string>();
  for (const s of seedSkills) {
    let [existing] = await db
      .select()
      .from(t.skills)
      .where(and(eq(t.skills.workspaceId, workspaceId), eq(t.skills.name, s.name)));
    if (!existing) {
      [existing] = await db
        .insert(t.skills)
        .values({ ...s, workspaceId })
        .returning();
    }
    skillIdByName.set(s.name, existing!.id);
    // v1 snapshot so the Versions tab is never empty for a seeded skill.
    await db
      .insert(t.skillVersions)
      .values({ skillId: existing!.id, version: 1, body: s.body })
      .onConflictDoNothing();
  }

  // `order` is the sequence of blocks in the assembled prompt: the specialised
  // rule first, then the shared quality rubric last.
  const seedAgentSkills: Array<{ agent: string; skill: string; order: number }> = [
    { agent: 'Test Quality Reviewer', skill: 'test-coverage-nudge', order: 0 },
    { agent: 'Test Quality Reviewer', skill: 'flaky-test-patterns', order: 1 },
    { agent: 'Test Quality Reviewer', skill: 'pr-quality-rubric', order: 2 },
    { agent: 'API Contract Reviewer', skill: 'api-contract-guard', order: 0 },
    { agent: 'API Contract Reviewer', skill: 'vendored-contract-sync', order: 1 },
    { agent: 'API Contract Reviewer', skill: 'pr-quality-rubric', order: 2 },
  ];
  for (const link of seedAgentSkills) {
    const agentId = agentIdByName.get(link.agent);
    const skillId = skillIdByName.get(link.skill);
    if (!agentId || !skillId) continue;
    await db
      .insert(t.agentSkills)
      .values({ agentId, skillId, order: link.order, enabled: true })
      .onConflictDoNothing();
  }

  return { workspaceId, userId };
}

// CLI entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const handle = createDb(url);
  seed(handle.db)
    .then(async (r) => {
      console.log('✓ seeded', r);
      await handle.close();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('✗ seed failed:', err);
      await handle.close();
      process.exit(1);
    });
}
