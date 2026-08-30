import { z } from 'zod';
import { Verdict, Finding } from './findings.js';
import { EvalRun, EvalOwnerKind, Conformance, Provider, CiFailOn } from './knowledge.js';

/**
 * A4 — Eval / CI / Compose / Conformance API contracts (L06).
 *
 * These EXTEND the barrel; they do not modify existing contract files. The base
 * `EvalRun`, `EvalCase`, `EvalOwnerKind`, `Conformance` live in `knowledge.ts`;
 * here we add the *API-facing* request/response shapes (records persisted in
 * `eval_runs`, `composed_reviews`, `ci_installations`, `ci_runs`,
 * `conformance_checks`) plus the eval-dashboard aggregate.
 */

// ===========================================================================
// Eval — case input + persisted run record + dashboard
// ===========================================================================

/** Create/update payload for an eval case (id + owner resolved by the route). */
export const EvalCaseInput = z.object({
  owner_kind: EvalOwnerKind,
  owner_id: z.string(),
  name: z.string().min(1),
  input_diff: z.string().default(''),
  input_files: z.unknown().nullish(),
  input_meta: z.unknown().nullish(),
  expected_output: z.unknown(),
  notes: z.string().nullish(),
});
export type EvalCaseInput = z.infer<typeof EvalCaseInput>;

/** A persisted eval run row (one execution of a case), returned by the API. */
export const EvalRunRecord = z.object({
  id: z.string(),
  case_id: z.string(),
  case_name: z.string().nullish(),
  /** The batch this row belongs to. Null only for rows written before SPEC-03. */
  batch_id: z.string().nullish(),
  ran_at: z.string(),
  actual_output: z.unknown(),
  pass: z.boolean().nullable(),
  recall: z.number().nullable(),
  precision: z.number().nullable(),
  citation_accuracy: z.number().nullable(),
  /**
   * The RAW counters the three rates above were computed from.
   *
   * A batch aggregates by summing counters, never by averaging per-case rates,
   * so without these a batch row can never be re-derived or audited from its
   * case rows (SPEC-03 AC-36).
   */
  tp: z.number().int().nullish(),
  fp: z.number().int().nullish(),
  fn: z.number().int().nullish(),
  kept: z.number().int().nullish(),
  dropped: z.number().int().nullish(),
  duration_ms: z.number().int().nullable(),
  tokens_in: z.number().int().nullish(),
  tokens_out: z.number().int().nullish(),
  cost_usd: z.number().nullable(),
  /** Why this case failed to execute; null on a case that ran (SPEC-03 AC-23). */
  error: z.string().nullish(),
});
export type EvalRunRecord = z.infer<typeof EvalRunRecord>;

/** Result of running a single case: the metrics (EvalRun) + the persisted row id. */
export const EvalRunResult = z.object({
  run_id: z.string(),
  case_id: z.string(),
  result: EvalRun,
});
export type EvalRunResult = z.infer<typeof EvalRunResult>;

/** One point on the dashboard trend (per run, chronological). */
export const EvalTrendPoint = z.object({
  ran_at: z.string(),
  recall: z.number(),
  precision: z.number(),
  citation_accuracy: z.number(),
  pass_rate: z.number(),
  cost_usd: z.number().nullable(),
});
export type EvalTrendPoint = z.infer<typeof EvalTrendPoint>;

/** Aggregate dashboard for an owner (agent/skill) or the whole workspace. */
export const EvalDashboard = z.object({
  owner_kind: EvalOwnerKind.nullable(),
  owner_id: z.string().nullable(),
  cases_total: z.number().int(),
  current: z.object({
    recall: z.number(),
    precision: z.number(),
    citation_accuracy: z.number(),
    traces_passed: z.number().int(),
    traces_total: z.number().int(),
    cost_usd: z.number().nullable(),
  }),
  delta: z.object({
    recall: z.number(),
    precision: z.number(),
    citation_accuracy: z.number(),
  }),
  trend: z.array(EvalTrendPoint),
  recent_runs: z.array(EvalRunRecord),
  alert: z.string().nullable(),
});
export type EvalDashboard = z.infer<typeof EvalDashboard>;

// ===========================================================================
// Eval — expectations, batches, comparison (SPEC-03)
// ===========================================================================

/**
 * What an eval case asserts. Derived from the decision the author already made
 * on the source finding: `accept` → must_find, `dismiss` → must_not_flag.
 */
export const EvalExpectationKind = z.enum(['must_find', 'must_not_flag']);
export type EvalExpectationKind = z.infer<typeof EvalExpectationKind>;

/**
 * One `file` + line-range the expectation points at.
 *
 * `severity` / `category` / `title` are copied off the source finding for
 * display only. Scoring NEVER reads them (SPEC-03 AC-28): a finding matches a
 * target when its file is equal AND its line range intersects, and on nothing
 * else. Keeping them here makes a case readable without joining back to a
 * finding that may since have been deleted.
 */
export const EvalExpectedTarget = z.object({
  file: z.string().min(1),
  start_line: z.number().int(),
  end_line: z.number().int(),
  severity: z.string().nullish(),
  category: z.string().nullish(),
  title: z.string().nullish(),
});
export type EvalExpectedTarget = z.infer<typeof EvalExpectedTarget>;

/** The parsed shape of `eval_cases.expected_output` (the column stays jsonb). */
export const EvalExpectation = z.object({
  kind: EvalExpectationKind,
  targets: z.array(EvalExpectedTarget).min(1),
});
export type EvalExpectation = z.infer<typeof EvalExpectation>;

/**
 * What `eval_runs.actual_output` holds.
 *
 * The dropped findings are persisted WITH the gate's reason, not just counted:
 * citation_accuracy is otherwise a number you cannot act on — you can see it
 * fell but not which citation was hallucinated (SPEC-03 AC-37).
 */
export const EvalActualOutput = z.object({
  findings: z.array(Finding),
  dropped: z.array(z.object({ finding: Finding, reason: z.string() })),
  grounding: z.string(),
});
export type EvalActualOutput = z.infer<typeof EvalActualOutput>;

export const EvalBatchStatus = z.enum(['running', 'done', 'failed']);
export type EvalBatchStatus = z.infer<typeof EvalBatchStatus>;

/**
 * One linked skill as it stood when a batch launched. A skill body is versioned
 * (`skills.version`), so an edit between two runs makes them incomparable —
 * this is what records that it happened (SPEC-03 AC-38, AC-43).
 */
export const EvalSkillSnapshot = z.object({
  skill_id: z.string(),
  name: z.string().nullish(),
  version: z.number().int(),
});
export type EvalSkillSnapshot = z.infer<typeof EvalSkillSnapshot>;

/**
 * One execution of a whole case set (`eval_run_batches`).
 *
 * Everything about the agent that could differ between two runs is snapshotted
 * here at launch and never updated, so a comparison can attribute a metric
 * movement to a specific definition change rather than guessing.
 */
export const EvalBatchRecord = z.object({
  id: z.string(),
  owner_kind: EvalOwnerKind,
  owner_id: z.string(),
  status: EvalBatchStatus,
  started_at: z.string(),
  finished_at: z.string().nullable(),
  // ---- immutable snapshot of the agent under test ----
  agent_version: z.number().int().nullable(),
  system_prompt: z.string(),
  skills_snapshot: z.array(EvalSkillSnapshot),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  // ---- results ----
  recall: z.number().nullable(),
  precision: z.number().nullable(),
  citation_accuracy: z.number().nullable(),
  traces_passed: z.number().int(),
  traces_total: z.number().int(),
  duration_ms: z.number().int().nullable(),
  tokens_in: z.number().int().nullable(),
  tokens_out: z.number().int().nullable(),
  cost_usd: z.number().nullable(),
  error: z.string().nullable(),
});
export type EvalBatchRecord = z.infer<typeof EvalBatchRecord>;

/** Response of `POST /agents/:id/eval-runs` — the batch is still running. */
export const EvalBatchStart = z.object({
  batch_id: z.string(),
  cases_total: z.number().int(),
});
export type EvalBatchStart = z.infer<typeof EvalBatchStart>;

/** A batch plus its per-case rows — what the run detail / poller reads. */
export const EvalBatchDetail = z.object({
  batch: EvalBatchRecord,
  runs: z.array(EvalRunRecord),
});
export type EvalBatchDetail = z.infer<typeof EvalBatchDetail>;

/** Signed change between two batches, for the compare view. */
export const EvalMetricDelta = z.object({
  recall: z.number().nullable(),
  precision: z.number().nullable(),
  citation_accuracy: z.number().nullable(),
  cost_usd: z.number().nullable(),
});
export type EvalMetricDelta = z.infer<typeof EvalMetricDelta>;

/**
 * Two batches side by side. `case_set_mismatch` is true when the two did not
 * execute the same set of cases — the delta is then not attributable to the
 * definition change and the surface must say so (SPEC-03 AC-42).
 */
export const EvalCompare = z.object({
  a: EvalBatchRecord,
  b: EvalBatchRecord,
  delta: EvalMetricDelta,
  case_set_mismatch: z.boolean(),
  skills_changed: z.boolean(),
});
export type EvalCompare = z.infer<typeof EvalCompare>;

// ===========================================================================
// Compose Review
// ===========================================================================

export const ComposeReviewInput = z.object({
  /** Finding ids to fold into the draft (optional — body may be hand-written). */
  finding_ids: z.array(z.string()).default([]),
  /** Editable markdown body. If omitted, the server composes one from findings. */
  body: z.string().nullish(),
  verdict: Verdict.default('comment'),
  /** When true, attach selected findings as inline comments (path+line+body). */
  inline_comments: z.boolean().default(false),
});
export type ComposeReviewInput = z.infer<typeof ComposeReviewInput>;
/** Caller-facing input type — `.default()` fields stay optional (web hooks). */
export type ComposeReviewInputBody = z.input<typeof ComposeReviewInput>;

/** A persisted composed review (mirrors the `composed_reviews` row). */
export const ComposedReview = z.object({
  id: z.string(),
  pr_id: z.string(),
  body: z.string(),
  verdict: Verdict.nullable(),
  posted_at: z.string().nullable(),
  github_review_id: z.string().nullable(),
});
export type ComposedReview = z.infer<typeof ComposedReview>;

/** A preview (no GitHub side-effect) of what would be posted. */
export const ComposeReviewPreview = z.object({
  body: z.string(),
  verdict: Verdict,
  inline_comments: z.array(
    z.object({ path: z.string(), line: z.number().int(), body: z.string() }),
  ),
});
export type ComposeReviewPreview = z.infer<typeof ComposeReviewPreview>;

// ===========================================================================
// Export-to-CI + CI Runs
// ===========================================================================

export const CiTarget = z.enum(['gha', 'circle', 'jenkins', 'cli']);
export type CiTarget = z.infer<typeof CiTarget>;

/** One generated file in the CI bundle (path + editable contents). */
export const CiFile = z.object({
  path: z.string(),
  contents: z.string(),
  editable: z.boolean().default(true),
});
export type CiFile = z.infer<typeof CiFile>;

/**
 * AgentManifest — the agent contract shared by the studio and the CI runner.
 *
 * The studio (`CiService.agentYaml`) WRITES this shape to
 * `.devdigest/agents/<slug>.yaml`; the agent-runner READS it. Keeping one Zod
 * schema for both ends guarantees the formats never drift. `skills` are slugs
 * resolved to `.devdigest/skills/<slug>.md`.
 */
export const AgentManifest = z.object({
  name: z.string().min(1),
  provider: Provider.default('openrouter'),
  model: z.string().min(1),
  system_prompt: z.string(),
  // Tolerate both a missing key and an explicit `null` (YAML `skills:` with no
  // value parses to null, which `.default([])` does NOT catch) — normalize both
  // to an empty array so manifests without skills validate cleanly.
  skills: z
    .array(z.string())
    .nullish()
    .transform((v) => v ?? []),
  strategy: z.enum(['auto', 'single-pass', 'map-reduce']).default('auto'),
  // CI gate policy (see CiFailOn) — when the posted review should BLOCK
  // (REQUEST_CHANGES + fail the check) vs just comment. Default: block on critical.
  ci_fail_on: CiFailOn.default('critical'),
});
export type AgentManifest = z.infer<typeof AgentManifest>;
/** Caller-facing input type — `.default()` fields stay optional. */
export type AgentManifestInput = z.input<typeof AgentManifest>;

/** Request body for `POST /agents/:id/export-ci`. */
export const CiExportInput = z.object({
  repo: z.string().min(1), // "owner/name"
  target: CiTarget.default('gha'),
  /** "open_pr" opens a PR with the files; "files" just returns/persists them. */
  action: z.enum(['open_pr', 'files']).default('open_pr'),
  post_as: z.enum(['github_review', 'pr_comment', 'none']).default('github_review'),
  triggers: z.array(z.string()).default(['opened', 'synchronize', 'reopened']),
  base: z.string().default('main'),
});
export type CiExportInput = z.infer<typeof CiExportInput>;
/** Caller-facing input type — `.default()` fields stay optional (web hooks). */
export type CiExportInputBody = z.input<typeof CiExportInput>;

/** A persisted CI installation (mirrors `ci_installations`). */
export const CiInstallation = z.object({
  id: z.string(),
  agent_id: z.string(),
  repo: z.string(),
  target_type: CiTarget,
  installed_at: z.string(),
});
export type CiInstallation = z.infer<typeof CiInstallation>;

/** Response of `POST /agents/:id/export-ci`. */
export const CiExport = z.object({
  installation: CiInstallation,
  files: z.array(CiFile),
  pr_url: z.string().nullable(),
});
export type CiExport = z.infer<typeof CiExport>;

export const CiRunStatus = z.enum(['succeeded', 'failed', 'no_findings', 'running']);
export type CiRunStatus = z.infer<typeof CiRunStatus>;

/** A CI run row (mirrors `ci_runs`) — ingested from GitHub Actions artifacts. */
export const CiRun = z.object({
  id: z.string(),
  ci_installation_id: z.string().nullable(),
  pr_number: z.number().int().nullable(),
  ran_at: z.string().nullable(),
  status: z.string().nullable(),
  findings_count: z.number().int().nullable(),
  cost_usd: z.number().nullable(),
  github_url: z.string().nullable(),
  source: z.string().nullable(),
  agent: z.string().nullish(),
  duration_s: z.number().nullish(),
});
export type CiRun = z.infer<typeof CiRun>;

/**
 * The artifact shape uploaded by the CI action (`devdigest-result.json`).
 * Ingested back on refresh to populate `ci_runs` (L06).
 */
export const CiResultArtifact = z.object({
  findings_count: z.number().int(),
  critical: z.number().int().nullish(),
  warning: z.number().int().nullish(),
  suggestion: z.number().int().nullish(),
  cost_usd: z.number().nullable(),
  duration_ms: z.number().int().nullish(),
  agent: z.string(),
  version: z.string().nullish(),
  pr_number: z.number().int().nullish(),
});
export type CiResultArtifact = z.infer<typeof CiResultArtifact>;

// ===========================================================================
// Conformance (PRD ↔ PR) — API record (the analysis shape is `Conformance`)
// ===========================================================================

/** Request body for `POST /pulls/:id/conformance`. */
export const ConformanceInput = z.object({
  /** Spec path/id to compare against; if omitted, the first available spec. */
  spec: z.string().nullish(),
  provider: z.enum(['openai', 'anthropic', 'openrouter']).nullish(),
  model: z.string().nullish(),
});
export type ConformanceInput = z.infer<typeof ConformanceInput>;

/** A persisted conformance check (mirrors `conformance_checks` + the report). */
export const ConformanceReport = z.object({
  id: z.string(),
  pr_id: z.string(),
  report: Conformance,
});
export type ConformanceReport = z.infer<typeof ConformanceReport>;

// ===========================================================================
// Hooks (Secret-Leak + Phantom-API detectors) — emit grounding-exempt findings
// ===========================================================================

export const HookKind = z.enum(['secret_leak', 'phantom']);
export type HookKind = z.infer<typeof HookKind>;

/** Result of running the built-in detectors over a PR. */
export const HookScanResult = z.object({
  pr_id: z.string(),
  review_id: z.string().nullable(),
  findings: z.array(Finding),
});
export type HookScanResult = z.infer<typeof HookScanResult>;
