import 'dotenv/config';
import { createDb, type Db } from './client.js';
import * as t from './schema.js';
import { eq, and, isNull } from 'drizzle-orm';
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

/**
 * Unified-diff hunks for the demo PR, keyed by path.
 *
 * These exist so the starter has a REAL diff without a clone on disk: with no
 * `pr_files.patch`, `diffFromPrFiles` reconstructs nothing, the grounding gate
 * drops every finding, and an eval case has no code to assert against. The line
 * numbers the seeded findings below cite all fall inside these hunks.
 */
export const DEMO_PATCHES: Record<string, string> = {
  'src/config.ts': `@@ -10,3 +10,7 @@ export const config = {
   port: Number(process.env.PORT ?? 3000),
+  stripeKey: "sk_live_51H8xq2Ka9Vn3PqLm7Rd0bZ4Xc",
+  webhookForwardUrl: process.env.WEBHOOK_FORWARD_URL ?? "",
+  rateLimitMax: 100,
+  rateLimitWindowMs: 60_000,
   redisUrl: process.env.REDIS_URL,
 };`,

  'src/middleware/ratelimit.ts': `@@ -40,2 +40,13 @@ export function rateLimit(opts: Options) {
   const buckets = new Map<string, Bucket>();
+  return async function middleware(req, res, next) {
+    const key = req.ip;
+    const bucket = buckets.get(key) ?? { tokens: opts.max, ts: Date.now() };
+    if (bucket.tokens <= 0) {
+      res.status(429).json({ error: "rate_limited" });
+      return;
+    }
+    bucket.tokens -= 1;
+    buckets.set(key, bucket);
+    next();
+  };
 }`,

  'src/api/public/webhooks.ts': `@@ -58,1 +58,13 @@ router.post("/webhooks/forward", async (req, res) => {
   const payload = req.body;
+  const target = req.body.forward_to ?? config.webhookForwardUrl;
+  // forwards wherever the caller asks — no allowlist
+  const upstream = await fetch(target, {
+    method: "POST",
+    headers: { "content-type": "application/json" },
+    body: JSON.stringify(payload),
+  });
+  if (!upstream.ok) {
+    logger.warn({ target, status: upstream.status }, "forward failed");
+  }
+  res.json({ forwarded: true });
+});`,

  'src/api/users.ts': `@@ -42,1 +42,8 @@ router.get("/users", async (req, res) => {
   const users = await db.select().from(usersTable);
+  const enriched = [];
+  for (const u of users) {
+    const org = await db.select().from(orgs).where(eq(orgs.id, u.orgId));
+    enriched.push({ ...u, org: org[0] });
+  }
+  res.json(enriched);
+});`,
};

/**
 * The demo review's findings, each carrying the decision an author would have
 * made. These decisions ARE the eval dataset: an accepted finding becomes a
 * `must_find` case, a dismissed one a `must_not_flag` case, so the L06 eval set
 * can be built by clicking rather than by inventing test scenarios.
 *
 * Six accepted + four dismissed clears the "at least 8 cases" bar with room to
 * leave a couple out. Every `line` falls inside a hunk in DEMO_PATCHES above —
 * a finding that fails the grounding gate would never reach the eval set.
 */
export const DEMO_FINDINGS: Array<{
  file: string;
  startLine: number;
  endLine: number;
  severity: string;
  category: string;
  title: string;
  rationale: string;
  suggestion: string | null;
  confidence: number;
  decision: 'accepted' | 'dismissed';
}> = [
  {
    file: 'src/config.ts',
    startLine: 11,
    endLine: 11,
    severity: 'CRITICAL',
    category: 'security',
    title: 'Hardcoded Stripe secret key in commit',
    rationale:
      'Line 11 contains a literal string starting with `sk_live_`, which appears to be a Stripe **secret key**. Committing this exposes it to anyone with read access to the repo — including via git history after a later removal.',
    suggestion:
      'Move the key to an environment variable and reference it via `process.env.STRIPE_SECRET_KEY`. **Rotate the key immediately** — assume it is already compromised.',
    confidence: 0.98,
    decision: 'accepted',
  },
  {
    file: 'src/config.ts',
    startLine: 13,
    endLine: 13,
    severity: 'SUGGESTION',
    category: 'style',
    title: 'Magic number for the rate-limit ceiling',
    rationale: 'The literal `100` would read better as a named constant.',
    suggestion: 'Extract `DEFAULT_RATE_LIMIT_MAX`.',
    confidence: 0.44,
    decision: 'dismissed',
  },
  {
    file: 'src/middleware/ratelimit.ts',
    startLine: 45,
    endLine: 45,
    severity: 'WARNING',
    category: 'bug',
    title: 'Retry-After header omitted on 429',
    rationale:
      'The 429 response carries no `Retry-After`, so a well-behaved client cannot tell when to retry and will hammer the endpoint.',
    suggestion: 'Set `Retry-After` to the remaining window in seconds.',
    confidence: 0.81,
    decision: 'accepted',
  },
  {
    file: 'src/middleware/ratelimit.ts',
    startLine: 49,
    endLine: 49,
    severity: 'WARNING',
    category: 'perf',
    title: 'Rate-limit buckets never expire',
    rationale:
      'Entries are added to `buckets` per client IP and never evicted, so memory grows without bound under real traffic.',
    suggestion: 'Evict entries older than the window, or use an LRU with a fixed cap.',
    confidence: 0.87,
    decision: 'accepted',
  },
  {
    file: 'src/middleware/ratelimit.ts',
    startLine: 43,
    endLine: 43,
    severity: 'SUGGESTION',
    category: 'style',
    title: 'Inline default bucket could be extracted',
    rationale: 'The inline `{ tokens, ts }` default could be a small factory.',
    suggestion: 'Extract `newBucket(opts)`.',
    confidence: 0.38,
    decision: 'dismissed',
  },
  {
    file: 'src/api/public/webhooks.ts',
    startLine: 59,
    endLine: 64,
    severity: 'CRITICAL',
    category: 'security',
    title: 'Lethal trifecta: untrusted input reaches an exfil path',
    rationale:
      'The forward target is taken from the request body and the full payload is POSTed to it. Untrusted input, private data and an outbound channel meet in one handler.',
    suggestion: 'Resolve the target from server-side configuration only.',
    confidence: 0.79,
    decision: 'accepted',
  },
  {
    file: 'src/api/public/webhooks.ts',
    startLine: 61,
    endLine: 61,
    severity: 'CRITICAL',
    category: 'security',
    title: 'SSRF: forward target has no allowlist',
    rationale:
      '`fetch(target)` accepts any caller-supplied URL, including `http://169.254.169.254/` and other internal addresses.',
    suggestion: 'Validate the target against an allowlist of known hosts before fetching.',
    confidence: 0.9,
    decision: 'accepted',
  },
  {
    file: 'src/api/public/webhooks.ts',
    startLine: 67,
    endLine: 67,
    severity: 'WARNING',
    category: 'bug',
    title: 'Missing await on logger.warn',
    rationale: 'The logger call may return a promise that is never awaited.',
    suggestion: 'Await the logger call.',
    confidence: 0.41,
    decision: 'dismissed',
  },
  {
    file: 'src/api/users.ts',
    startLine: 44,
    endLine: 46,
    severity: 'WARNING',
    category: 'perf',
    title: 'N+1 query in user list endpoint',
    rationale:
      'The loop issues one org lookup per user, so the endpoint runs N+1 queries and degrades linearly with the user count.',
    suggestion: 'Fetch the orgs in a single `IN` query and group them in memory.',
    confidence: 0.86,
    decision: 'accepted',
  },
  {
    file: 'src/api/users.ts',
    startLine: 43,
    endLine: 43,
    severity: 'SUGGESTION',
    category: 'style',
    title: 'Prefer a typed array over an untyped literal',
    rationale: '`const enriched = []` is implicitly `any[]`.',
    suggestion: 'Annotate the array element type.',
    confidence: 0.35,
    decision: 'dismissed',
  },
];

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

    // pr_files (subset). `patch` matters: with no clone on disk the reviewer
    // reconstructs the diff from these hunks (`diffFromPrFiles`), and without
    // them every finding fails the grounding gate and no eval case can cite a
    // real line.
    await db.insert(t.prFiles).values([
      {
        prId: pr!.id,
        path: 'src/middleware/ratelimit.ts',
        additions: 11,
        deletions: 0,
        patch: DEMO_PATCHES['src/middleware/ratelimit.ts'],
      },
      {
        prId: pr!.id,
        path: 'src/api/public/webhooks.ts',
        additions: 12,
        deletions: 0,
        patch: DEMO_PATCHES['src/api/public/webhooks.ts'],
      },
      {
        prId: pr!.id,
        path: 'src/config.ts',
        additions: 4,
        deletions: 0,
        patch: DEMO_PATCHES['src/config.ts'],
      },
      {
        prId: pr!.id,
        path: 'src/api/users.ts',
        additions: 6,
        deletions: 0,
        patch: DEMO_PATCHES['src/api/users.ts'],
      },
    ]);

    // pr_commits
    await db.insert(t.prCommits).values({
      prId: pr!.id,
      sha: 'a1b2c3d4e5f6',
      message: 'Add token-bucket rate limiter',
      author: 'marisa.koch',
    });

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

  // ---- demo review + decided findings (the eval dataset) -------------------
  // OUTSIDE the `if (!pr)` guard on purpose: that block is skipped on a re-seed
  // once PR #482 exists, so anything nested in it never lands on an existing DB
  // (server/INSIGHTS.md, 2026-06-27). This section is idempotent on its own.
  //
  // The review is attributed to the Security Reviewer rather than left with a
  // null `agent_id`: an eval case belongs to the agent that produced the
  // finding, so an unattributed review cannot seed one at all.
  const securityAgentId = agentIdByName.get('Security Reviewer') ?? null;

  // Backfill patches on a database seeded before they existed.
  for (const [path, patch] of Object.entries(DEMO_PATCHES)) {
    await db
      .update(t.prFiles)
      .set({ patch })
      .where(and(eq(t.prFiles.prId, pr!.id), eq(t.prFiles.path, path), isNull(t.prFiles.patch)));
  }

  let [demoReview] = await db
    .select()
    .from(t.reviews)
    .where(and(eq(t.reviews.prId, pr!.id), eq(t.reviews.model, 'seed')));
  if (!demoReview) {
    [demoReview] = await db
      .insert(t.reviews)
      .values({
        workspaceId,
        prId: pr!.id,
        agentId: securityAgentId,
        kind: 'review',
        verdict: 'request_changes',
        summary:
          'Two critical exposures — a committed live Stripe key and an SSRF-shaped webhook forwarder — plus an unbounded limiter cache and an N+1 in the user list. Block before merge.',
        score: 38,
        model: 'seed',
      })
      .returning();
  } else if (!demoReview.agentId && securityAgentId) {
    // Pre-existing seeded review from before this section owned attribution.
    await db
      .update(t.reviews)
      .set({ agentId: securityAgentId })
      .where(eq(t.reviews.id, demoReview.id));
  }

  // Top up by TITLE rather than skipping when any finding exists. A database
  // seeded before this section carries the original two undecided findings, so
  // an "insert only when empty" guard would leave it permanently short of the
  // decided findings the eval set is built from — and the demo would silently
  // have nothing to click.
  const existing = await db
    .select({ title: t.findings.title })
    .from(t.findings)
    .where(eq(t.findings.reviewId, demoReview!.id));
  const seenTitles = new Set(existing.map((f) => f.title));
  const missing = DEMO_FINDINGS.filter((f) => !seenTitles.has(f.title));
  if (missing.length > 0) {
    const decidedAt = new Date();
    await db.insert(t.findings).values(
      missing.map((f) => ({
        reviewId: demoReview!.id,
        file: f.file,
        startLine: f.startLine,
        endLine: f.endLine,
        severity: f.severity,
        category: f.category,
        title: f.title,
        rationale: f.rationale,
        suggestion: f.suggestion,
        confidence: f.confidence,
        // Pre-decided so the eval set can be built by clicking "Turn into eval
        // case" straight away, without re-triaging the demo PR by hand.
        acceptedAt: f.decision === 'accepted' ? decidedAt : null,
        dismissedAt: f.decision === 'dismissed' ? decidedAt : null,
      })),
    );
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
