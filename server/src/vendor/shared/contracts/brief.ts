import { z } from 'zod';

/**
 * PR Brief building blocks: Intent, Blast radius, Risks, PR History,
 * Smart Diff. Composed into PrBrief.
 */

// ---- Intent ----

/** Where one piece of classifier context came from. */
export const IntentSourceKind = z.enum([
  'title',
  'body',
  'linked_issue',
  'spec_file',
  'url',
  'file_list',
]);
export type IntentSourceKind = z.infer<typeof IntentSourceKind>;

/** Whether that source made it into the classifier prompt. */
export const IntentSourceStatus = z.enum(['used', 'missing']);
export type IntentSourceStatus = z.infer<typeof IntentSourceStatus>;

/**
 * One assembled (or deliberately skipped) classifier input. `missing` entries
 * are surfaced with their `reason` rather than hidden, so the UI can show what
 * the system did NOT know instead of silently inventing it.
 */
export const IntentSource = z.object({
  kind: IntentSourceKind,
  ref: z.string().nullish(),
  status: IntentSourceStatus,
  reason: z.string().nullish(),
});
export type IntentSource = z.infer<typeof IntentSource>;

export const IntentConfidence = z.enum(['low', 'medium', 'high']);
export type IntentConfidence = z.infer<typeof IntentConfidence>;

/**
 * Intent — the cheap classifier's understanding of what a PR is trying to do.
 * Everything past `out_of_scope` is `.nullish()` so legacy/model-authored
 * payloads (and `PrBrief`, which composes this) keep parsing.
 */
export const Intent = z.object({
  intent: z.string(),
  in_scope: z.array(z.string()),
  out_of_scope: z.array(z.string()),
  /** 0–1, computed by code from the assembled sources; the model can only lower it. */
  confidence: z.number().min(0).max(1).nullish(),
  confidence_level: IntentConfidence.nullish(),
  sources: z.array(IntentSource).default([]),
  /** Commit the intent was derived from; a different head sha means stale. */
  head_sha: z.string().nullish(),
  generated_at: z.string().nullish(),
  provider: z.string().nullish(),
  model: z.string().nullish(),
  cost_usd: z.number().nullish(),
});
export type Intent = z.infer<typeof Intent>;

// ---- Blast radius ----
export const ChangedSymbol = z.object({
  name: z.string(),
  file: z.string(),
  kind: z.string(),
});
export type ChangedSymbol = z.infer<typeof ChangedSymbol>;

export const BlastCaller = z.object({
  name: z.string(),
  file: z.string(),
  line: z.number().int(),
});
export type BlastCaller = z.infer<typeof BlastCaller>;

/**
 * An endpoint or cron the change can reach, with how far away it is.
 *
 * The depth is not decoration. Attribution at two hops is TRUE but weak: in any
 * repo with a barrel or registry file, every module reaches the app root in two
 * hops, so a flat list drifts toward "every change affects every endpoint".
 * Carrying the distance lets the reader rank instead of forcing the server to
 * either discard real edges or drown the useful ones.
 */
export const AffectedEndpoint = z.object({
  endpoint: z.string(),
  /** 1 = a direct caller or direct importer declares it; 2 = one hop further. */
  depth: z.number().int(),
});
export type AffectedEndpoint = z.infer<typeof AffectedEndpoint>;

export const DownstreamImpact = z.object({
  symbol: z.string(),
  callers: z.array(BlastCaller),
  /**
   * Callers found BEFORE the per-symbol display cap. Lets the UI say
   * "showing 20 of 43" instead of presenting a truncated list as the whole set.
   */
  caller_total: z.number().int().default(0),
  endpoints_affected: z.array(AffectedEndpoint),
  crons_affected: z.array(AffectedEndpoint),
});
export type DownstreamImpact = z.infer<typeof DownstreamImpact>;

/**
 * State of the repo index the map was read from. Structured, not prose, because
 * "we found nothing" and "we never finished looking" are different claims and
 * the UI has to render them differently. `missing` = never indexed; `partial` =
 * a working index that skipped some work (see pipeline soft budget); `failed` =
 * the indexer errored.
 */
export const BlastIndexStatus = z.enum(['full', 'partial', 'missing', 'failed']);
export type BlastIndexStatus = z.infer<typeof BlastIndexStatus>;

export const BlastIndexInfo = z.object({
  status: BlastIndexStatus,
  reason: z.string().nullable().default(null),
  files_indexed: z.number().int().default(0),
  last_indexed_sha: z.string().default(''),
  updated_at: z.string().default(''),
});
export type BlastIndexInfo = z.infer<typeof BlastIndexInfo>;

export const BlastRadius = z.object({
  index: BlastIndexInfo,
  changed_symbols: z.array(ChangedSymbol),
  downstream: z.array(DownstreamImpact),
  /**
   * Flat union across the whole PR. Not derivable from `downstream` on the
   * degraded index path, where an endpoint is known to be impacted but cannot be
   * attributed to a specific changed symbol — so it is reported here instead of
   * being smeared across every symbol.
   */
  impacted_endpoints: z.array(z.string()).default([]),
  impacted_crons: z.array(z.string()).default([]),
  summary: z.string(),
});
export type BlastRadius = z.infer<typeof BlastRadius>;

// ---- Risks ----
export const RiskSeverity = z.enum(['high', 'medium', 'low']);
export type RiskSeverity = z.infer<typeof RiskSeverity>;

export const Risk = z.object({
  kind: z.string(),
  title: z.string(),
  explanation: z.string(),
  severity: RiskSeverity,
  file_refs: z.array(z.string()),
});
export type Risk = z.infer<typeof Risk>;

export const Risks = z.object({
  risks: z.array(Risk),
});
export type Risks = z.infer<typeof Risks>;

// ---- PR History ----
export const PrHistoryItem = z.object({
  pr_number: z.number().int(),
  title: z.string(),
  merged_at: z.string(),
  author: z.string(),
  files_overlap: z.array(z.string()),
  notes: z.string(),
});
export type PrHistoryItem = z.infer<typeof PrHistoryItem>;

export const PrHistory = z.object({
  history: z.array(PrHistoryItem),
});
export type PrHistory = z.infer<typeof PrHistory>;

// ---- Smart Diff ----
export const SmartDiffRole = z.enum(['core', 'wiring', 'boilerplate']);
export type SmartDiffRole = z.infer<typeof SmartDiffRole>;

export const SmartDiffFile = z.object({
  path: z.string(),
  pseudocode_summary: z.string().nullish(),
  additions: z.number().int(),
  deletions: z.number().int(),
  finding_lines: z.array(z.number().int()),
});
export type SmartDiffFile = z.infer<typeof SmartDiffFile>;

export const SmartDiffGroup = z.object({
  role: SmartDiffRole,
  files: z.array(SmartDiffFile),
});
export type SmartDiffGroup = z.infer<typeof SmartDiffGroup>;

export const ProposedSplit = z.object({
  name: z.string(),
  files: z.array(z.string()),
});
export type ProposedSplit = z.infer<typeof ProposedSplit>;

export const SmartDiff = z.object({
  groups: z.array(SmartDiffGroup),
  split_suggestion: z.object({
    too_big: z.boolean(),
    total_lines: z.number().int(),
    proposed_splits: z.array(ProposedSplit),
  }),
});
export type SmartDiff = z.infer<typeof SmartDiff>;

// ---- Composed PR Brief (read-model) ----
/**
 * `PrBrief` composes the four building blocks above — Intent, BlastRadius,
 * Risks and PrHistory — into one per-PR read-model.
 *
 * It is NOT the payload of `pr_brief.json`, despite what this comment used to
 * claim: that column holds `PrRiskBriefRecord` (`contracts/risk-brief.ts`),
 * the generated "what / why / how risky / read this first" brief. `PrBrief`
 * keeps its name and shape for its existing consumers.
 */
export const PrBrief = z.object({
  intent: Intent,
  blast: BlastRadius,
  risks: Risks,
  history: PrHistory,
});
export type PrBrief = z.infer<typeof PrBrief>;
