import { z } from 'zod';

/**
 * Run trace. The ENTIRE trace of one run is persisted as a SINGLE
 * jsonb document in `run_traces` (not per-row). Live events stream via SSE
 * during the run; the full log is written once on completion.
 */

export const RunEventKind = z.enum(['info', 'tool', 'result', 'error']);
export type RunEventKind = z.infer<typeof RunEventKind>;

/** A single live-log line. `t` = elapsed timestamp string (e.g. "00.31"). */
export const RunLogLine = z.object({
  t: z.string(),
  kind: RunEventKind,
  msg: z.string(),
});
export type RunLogLine = z.infer<typeof RunLogLine>;

/** SSE payload streamed on `/runs/:id/events`. */
export const RunEvent = z.object({
  runId: z.string(),
  seq: z.number().int(),
  kind: RunEventKind,
  msg: z.string(),
  t: z.string(),
  data: z.unknown().optional(),
});
export type RunEvent = z.infer<typeof RunEvent>;

export const ToolCall = z.object({
  tool: z.string(),
  args: z.string(),
  meta: z.string().nullish(),
  ms: z.number().int(),
});
export type ToolCall = z.infer<typeof ToolCall>;

export const PromptAssembly = z.object({
  system: z.string(),
  skills: z.string().nullish(),
  memory: z.string().nullish(),
  specs: z.string().nullish(),
  /** Callers-of-changed-symbols digest (T1.3); null when absent. */
  callers: z.string().nullish(),
  /** Repo skeleton / map (T3); null when absent. Enables per-slot token
      attribution in the run trace. */
  repo_map: z.string().nullish(),
  /** PR author's description/body (truncated); null when absent. */
  pr_description: z.string().nullish(),
  /** Rendered (untrusted-wrapped) derived intent/scope block; null when absent. */
  intent: z.string().nullish(),
  user: z.string(),
});
export type PromptAssembly = z.infer<typeof PromptAssembly>;

export const MemoryPulled = z.object({
  pr: z.number().int().nullish(),
  text: z.string(),
});
export type MemoryPulled = z.infer<typeof MemoryPulled>;

export const RunStats = z.object({
  duration_ms: z.number().int(),
  tokens_in: z.number().int(),
  tokens_out: z.number().int(),
  cost_usd: z.number().nullable(),
  findings: z.number().int(),
  grounding: z.string(),
});
export type RunStats = z.infer<typeof RunStats>;

/**
 * One project-context document as the run actually resolved it (SPEC-01).
 *
 * The ledger is written by the SERVER, not the model, and records the misses as
 * well as the hits: a document attached to an agent but absent from the clone is
 * reported with its reason rather than silently dropped, so a review that ran
 * without a rule the author believed was in force is visible as such.
 *
 * `reason` is null on `used` and one of `unsafe_path` / `empty_file` /
 * `not_in_clone` on `missing` — the same vocabulary the intent module's source
 * ledger already uses.
 */
export const SpecRead = z.object({
  path: z.string(),
  status: z.enum(['used', 'missing']),
  reason: z.string().nullish(),
  /** Approximate tokens the document contributed (`ceil(chars/4)`); 0 when missing. */
  tokens: z.number().int(),
});
export type SpecRead = z.infer<typeof SpecRead>;

/** The single-document trace stored in `run_traces.trace`. */
export const RunTrace = z.object({
  config: z.object({
    agent: z.string(),
    version: z.string().nullish(),
    provider: z.string().nullish(),
    model: z.string(),
    pr: z.number().int().nullish(),
    source: z.enum(['local', 'ci']).default('local'),
  }),
  stats: RunStats,
  prompt_assembly: PromptAssembly,
  tool_calls: z.array(ToolCall),
  raw_output: z.string(),
  memory_pulled: z.array(MemoryPulled),
  /**
   * Paths of the project-context documents that were actually assembled into the
   * prompt — `specs_detail` filtered to `used`. Historically hardcoded to `[]`
   * by the run executor; SPEC-01 makes it real. Never write a literal here.
   */
  specs_read: z.array(z.string()),
  /**
   * The full read ledger, misses included. `.nullish()` because `run_traces` is
   * a FROZEN jsonb snapshot: every trace persisted before SPEC-01 lacks this key
   * and must still parse. (`.default([])` would make it REQUIRED on output and
   * break every existing RunTrace constructor — see server/INSIGHTS.md 2026-08-11.)
   */
  specs_detail: z.array(SpecRead).nullish(),
  /** Approximate total tokens contributed by the used documents. Nullish for the
      same frozen-snapshot reason as `specs_detail`. */
  specs_tokens: z.number().int().nullish(),
  log: z.array(RunLogLine),
});
export type RunTrace = z.infer<typeof RunTrace>;

/**
 * One row of a PR's run history (every agent_runs row, any status). Surfaced on
 * the PR page so runs — including FAILED ones with their error — survive reload.
 */
export const RunSummary = z.object({
  run_id: z.string(),
  agent_id: z.string().nullable(),
  agent_name: z.string().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  status: z.string().nullable(), // running | done | failed | cancelled
  error: z.string().nullable(),
  duration_ms: z.number().int().nullable(),
  tokens_in: z.number().int().nullable(),
  tokens_out: z.number().int().nullable(),
  cost_usd: z.number().nullable(),
  findings_count: z.number().int().nullable(),
  grounding: z.string().nullable(),
  ran_at: z.string().nullable(),
  // Review outcome, denormalized onto the run row at completion (the timeline
  // has no FK to the review). score = the review's 0-100 score; blockers =
  // findings that trip the agent's gate. Null on failed/cancelled runs.
  score: z.number().int().nullable(),
  blockers: z.number().int().nullable(),
});
export type RunSummary = z.infer<typeof RunSummary>;
