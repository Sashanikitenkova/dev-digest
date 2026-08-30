import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  doublePrecision,
  index,
} from 'drizzle-orm/pg-core';
import { workspaces } from './core';
import { pullRequests } from './pulls';
import { findings } from './reviews';

// ============================================================ Eval / Conformance / Compose

/**
 * Structural mirrors of the `EvalExpectation` / `EvalSkillSnapshot` contracts
 * (`vendor/shared/contracts/eval-ci.ts`). The schema layer deliberately does not
 * import from `vendor/shared` — same precedent as `IntentSourceRow` and
 * `PrRiskBriefPayload` in `./reviews.ts`.
 */
export type EvalExpectationTargetJson = {
  file: string;
  start_line: number;
  end_line: number;
  severity?: string | null;
  category?: string | null;
  title?: string | null;
};

export type EvalExpectationJson = {
  kind: 'must_find' | 'must_not_flag';
  targets: EvalExpectationTargetJson[];
};

export type EvalSkillSnapshotJson = {
  skill_id: string;
  name?: string | null;
  version: number;
};

export const evalCases = pgTable(
  'eval_cases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    ownerKind: text('owner_kind', { enum: ['skill', 'agent'] }).notNull(),
    ownerId: uuid('owner_id').notNull(),
    name: text('name').notNull(),
    inputDiff: text('input_diff'),
    inputFiles: jsonb('input_files'),
    inputMeta: jsonb('input_meta'),
    /** Parses as the `EvalExpectation` contract: `{ kind, targets[] }`. */
    expectedOutput: jsonb('expected_output').$type<EvalExpectationJson>(),
    notes: text('notes'),
    /**
     * The finding this case was frozen from (SPEC-03 AC-10).
     *
     * `set null`, deliberately NOT `cascade`: a case is a frozen fixture, so
     * re-running a review — which deletes and re-inserts that review's findings
     * — must not silently destroy the eval set built from the previous run.
     * Null is therefore a normal state, not a broken row.
     */
    sourceFindingId: uuid('source_finding_id').references(() => findings.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    ownerIdx: index('eval_cases_owner_idx').on(t.workspaceId, t.ownerKind, t.ownerId),
    srcIdx: index('eval_cases_source_finding_idx').on(t.sourceFindingId),
  }),
);

/**
 * One execution of a whole case set (SPEC-03).
 *
 * `eval_runs` is per CASE; this is the per-RUN parent that makes "old prompt vs
 * new prompt" a comparison rather than a guess. Everything about the agent that
 * could differ between two runs is snapshotted here at launch and never updated
 * — prompt, config version, provider, model, and the linked skills with their
 * versions (a skill body is versioned, so editing one silently makes two runs
 * incomparable unless it is recorded).
 *
 * Deliberately NOT `agent_runs`: that table is the observability record of real
 * PR reviews and feeds the run-cost badge and the per-agent accept-rate stats.
 * Synthetic replays landing there would corrupt both (SPEC-03 AC-25).
 */
export const evalRunBatches = pgTable(
  'eval_run_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    ownerKind: text('owner_kind', { enum: ['skill', 'agent'] }).notNull(),
    ownerId: uuid('owner_id').notNull(),
    status: text('status', { enum: ['running', 'done', 'failed'] })
      .notNull()
      .default('running'),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    // ---- immutable snapshot of the agent under test ----
    agentVersion: integer('agent_version'),
    systemPrompt: text('system_prompt').notNull(),
    /** `[{ skill_id, name, version }]` — the enabled links at launch time. */
    skillsSnapshot: jsonb('skills_snapshot').$type<EvalSkillSnapshotJson[]>(),
    provider: text('provider'),
    model: text('model'),
    // ---- aggregate results (summed from the per-case counters, never averaged) ----
    recall: doublePrecision('recall'),
    precision: doublePrecision('precision'),
    citationAccuracy: doublePrecision('citation_accuracy'),
    tracesPassed: integer('traces_passed').notNull().default(0),
    tracesTotal: integer('traces_total').notNull().default(0),
    durationMs: integer('duration_ms'),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    costUsd: doublePrecision('cost_usd'),
    error: text('error'),
  },
  (t) => ({
    ownerIdx: index('eval_batches_owner_idx').on(t.workspaceId, t.ownerKind, t.ownerId),
  }),
);

export const evalRuns = pgTable(
  'eval_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => evalCases.id, { onDelete: 'cascade' }),
    /** Null only for rows written before SPEC-03 introduced batches. */
    batchId: uuid('batch_id').references(() => evalRunBatches.id, { onDelete: 'cascade' }),
    ranAt: timestamp('ran_at', { withTimezone: true }).defaultNow().notNull(),
    /** Parses as `EvalActualOutput`: kept findings + DROPPED ones with reasons. */
    actualOutput: jsonb('actual_output'),
    pass: boolean('pass'),
    recall: doublePrecision('recall'),
    precision: doublePrecision('precision'),
    citationAccuracy: doublePrecision('citation_accuracy'),
    /**
     * The RAW counters the three rates above were computed from.
     *
     * A batch aggregates by SUMMING these, never by averaging the per-case
     * rates, so without them a batch row can never be re-derived or audited
     * from its case rows (SPEC-03 AC-36).
     */
    tp: integer('tp'),
    fp: integer('fp'),
    fn: integer('fn'),
    kept: integer('kept'),
    dropped: integer('dropped'),
    durationMs: integer('duration_ms'),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    costUsd: doublePrecision('cost_usd'),
    /** Why this case failed to execute; null on a case that ran. */
    error: text('error'),
  },
  (t) => ({
    batchIdx: index('eval_runs_batch_idx').on(t.batchId),
    caseIdx: index('eval_runs_case_ran_idx').on(t.caseId, t.ranAt),
  }),
);

export const conformanceChecks = pgTable('conformance_checks', {
  id: uuid('id').primaryKey().defaultRandom(),
  prId: uuid('pr_id')
    .notNull()
    .references(() => pullRequests.id, { onDelete: 'cascade' }),
  specId: text('spec_id').notNull(),
  completenessPct: doublePrecision('completeness_pct'),
  items: jsonb('items'),
});

export const composedReviews = pgTable('composed_reviews', {
  id: uuid('id').primaryKey().defaultRandom(),
  prId: uuid('pr_id')
    .notNull()
    .references(() => pullRequests.id, { onDelete: 'cascade' }),
  body: text('body').notNull(),
  verdict: text('verdict'),
  postedAt: timestamp('posted_at', { withTimezone: true }),
  githubReviewId: text('github_review_id'),
});
