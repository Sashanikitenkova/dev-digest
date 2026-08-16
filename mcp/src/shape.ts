import type { ApiAgent, ApiConvention, ApiFinding, ApiReview } from './ports.js';

/**
 * DOMAIN ring — pure token shaping. DTO in, concise MCP output out.
 *
 * This is where design principle #3 (*concise structured response*) is actually
 * enforced. Every field the API returns that does not help the model act is
 * dropped here, not in the tools — so the choice is testable without a port and
 * cannot drift per tool.
 */

/** Verbatim per the tool descriptions: "Defaults to 20." */
export const DEFAULT_MAX_FINDINGS = 20;

/** Verbatim per the tool description: "Defaults to 30." */
export const DEFAULT_MAX_CONVENTIONS = 30;

/** Most severe first. */
const SEVERITY_RANK: Record<string, number> = {
  CRITICAL: 0,
  WARNING: 1,
  SUGGESTION: 2,
};

// ---- Tool result envelope -------------------------------------------------

/**
 * Deliberately a `type` alias, not an `interface`. The SDK's `CallToolResult`
 * carries an `[x: string]: unknown` index signature, and TypeScript only grants
 * an *implicit* index signature to type aliases — an interface with the same
 * members fails to assign, with a misleading "Property 'resultType' is missing"
 * error pointing at the wrong union member.
 */
export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/**
 * A successful result. Both channels are populated: `structuredContent` for
 * hosts that read it, and the same payload serialized as text for hosts that
 * do not (the spec asks servers to provide both).
 */
export function ok(structured: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

/**
 * A failure the model can act on. Note `isError: true` deliberately carries no
 * `structuredContent` — the SDK skips output validation for error results, so a
 * tool with an `outputSchema` can still report a plain message.
 */
export function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// ---- Agents ---------------------------------------------------------------

export interface ShapedAgent {
  name: string;
  description: string;
  model: string;
  enabled: boolean;
}

/**
 * `id` is dropped on purpose — the model passes `name` straight back to
 * `run_agent_on_pr`. `system_prompt` is dropped because a single seeded prompt
 * runs to thousands of tokens; returning four would blow the session budget on
 * the very first call.
 *
 * Disabled agents are returned WITH the flag, not filtered out:
 * `POST /pulls/:id/review` with an explicit `agentId` does run a disabled
 * agent, so hiding them would make a legal call look impossible.
 */
export function shapeAgents(agents: readonly ApiAgent[]): ShapedAgent[] {
  return agents.map((a) => ({
    name: a.name,
    description: a.description,
    model: a.model,
    enabled: a.enabled,
  }));
}

// ---- Findings -------------------------------------------------------------

export interface ShapedFinding {
  severity: string;
  category: string;
  title: string;
  file: string;
  start_line: number;
  end_line: number;
  suggestion?: string;
  rationale?: string;
  confidence?: number;
}

export interface ShapeFindingsOptions {
  /** Include `rationale` (markdown, the single largest field) and `confidence`. */
  detail?: boolean;
  /** Maximum findings to keep, most severe first. */
  max?: number;
}

/**
 * Severity-ordered, truncated, field-selected. `rationale` is omitted unless
 * `detail` is set — that is the measured bulk of a finding's tokens, and it is
 * available on demand through `get_findings({ detail: true })`.
 */
export function shapeFindings(
  findings: readonly ApiFinding[],
  options: ShapeFindingsOptions = {},
): ShapedFinding[] {
  const max = options.max ?? DEFAULT_MAX_FINDINGS;
  const detail = options.detail ?? false;

  // Stable sort (V8 guarantees stability), so equal severities keep API order.
  const sorted = [...findings].sort(
    (a, b) => (SEVERITY_RANK[a.severity] ?? 99) - (SEVERITY_RANK[b.severity] ?? 99),
  );

  return sorted.slice(0, Math.max(0, max)).map((f) => {
    const shaped: ShapedFinding = {
      severity: f.severity,
      category: f.category,
      title: f.title,
      file: f.file,
      start_line: f.start_line,
      end_line: f.end_line,
    };
    if (f.suggestion) shaped.suggestion = f.suggestion;
    if (detail) {
      shaped.rationale = f.rationale;
      shaped.confidence = f.confidence;
    }
    return shaped;
  });
}

// ---- Reviews --------------------------------------------------------------

export interface ShapedReview {
  verdict?: string;
  score?: number;
  summary?: string;
  agent?: string;
  findings_count: number;
  findings: ShapedFinding[];
}

/**
 * `findings_count` is the review's FULL count, deliberately not the truncated
 * array length — otherwise truncation is invisible and the model cannot tell it
 * should raise `max_findings`.
 */
export function shapeReview(review: ApiReview, options: ShapeFindingsOptions = {}): ShapedReview {
  const shaped: ShapedReview = {
    findings_count: review.findings.length,
    findings: shapeFindings(review.findings, options),
  };
  if (review.verdict !== null) shaped.verdict = review.verdict;
  if (review.score !== null) shaped.score = review.score;
  if (review.summary !== null) shaped.summary = review.summary;
  if (review.agent_name) shaped.agent = review.agent_name;
  return shaped;
}

// ---- Conventions ----------------------------------------------------------

export interface ShapedConvention {
  rule: string;
  category?: string;
  evidence_path: string;
  evidence_line?: number;
  confidence: number;
}

export interface ShapeConventionsOptions {
  /** Keep only this triage status. */
  status?: 'accepted' | 'pending' | 'rejected';
  /** Maximum conventions to keep, highest confidence first. */
  max?: number;
}

/**
 * `id`, `created_at` and `evidence_snippet` are dropped: the snippet duplicates
 * what the agent can read straight from `evidence_path:evidence_line`.
 */
export function shapeConventions(
  conventions: readonly ApiConvention[],
  options: ShapeConventionsOptions = {},
): ShapedConvention[] {
  const max = options.max ?? DEFAULT_MAX_CONVENTIONS;
  const status = options.status ?? 'accepted';

  return conventions
    .filter((c) => c.status === status)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, Math.max(0, max))
    .map((c) => {
      const shaped: ShapedConvention = {
        rule: c.rule,
        evidence_path: c.evidence_path,
        confidence: c.confidence,
      };
      if (c.category) shaped.category = c.category;
      if (c.evidence_line !== null && c.evidence_line !== undefined) {
        shaped.evidence_line = c.evidence_line;
      }
      return shaped;
    });
}
