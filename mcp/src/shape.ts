import type { ApiAgent, ApiBlast, ApiConvention, ApiFinding, ApiReview } from './ports.js';

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

/** Changed symbols listed in a blast map before the tail is summarised away. */
export const MAX_BLAST_SYMBOLS = 10;

/** Callers listed per symbol over MCP — well under the API's own per-symbol 20. */
export const MAX_BLAST_CALLERS = 5;

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

export interface ShapedBlastSymbol {
  symbol: string;
  file: string;
  /** `path:line`, ready to open — the format the model already reads elsewhere. */
  callers: string[];
  caller_total: number;
  endpoints?: string[];
  crons?: string[];
  /** Reached through another module — true, but much weaker evidence. */
  endpoints_indirect?: string[];
  crons_indirect?: string[];
}

export interface ShapedBlast {
  index_status: 'full' | 'partial' | 'missing' | 'failed';
  summary: string;
  changed_symbols: number;
  symbols: ShapedBlastSymbol[];
  impacted_endpoints: string[];
  impacted_crons: string[];
  /** Present only when the map is not trustworthy on its own. */
  caveat?: string;
}

/**
 * Shape a blast map for a model.
 *
 * Two decisions worth stating. First, callers collapse to `path:line` strings
 * rather than objects: the enclosing symbol name is a label, while the location
 * is the thing an agent acts on, and one string costs a fraction of a
 * three-field object across a wide fan-out.
 *
 * Second, `caveat`. A `partial` index and a `full` one can both return an empty
 * map, and only one of those means "nothing is affected". The caveat spells the
 * difference out in the payload instead of relying on the model to infer it
 * from a status enum it has no prior for.
 *
 * Third, direct and indirect impact go in SEPARATE keys rather than one list.
 * A 2-hop endpoint is reached through a module in between — via a barrel file
 * that is every module in the repo — and a flat list invites the model to treat
 * it as equal to an endpoint whose own file calls the changed symbol. The key
 * name carries that distinction where a `depth: 2` field would not.
 */
export function shapeBlast(payload: ApiBlast): ShapedBlast {
  const b = payload.blast;

  const symbols: ShapedBlastSymbol[] = b.downstream
    .slice()
    .sort((x, y) => y.callers.length - x.callers.length)
    .slice(0, MAX_BLAST_SYMBOLS)
    .map((d) => {
      const declaredIn = b.changed_symbols.find((c) => c.name === d.symbol);
      const shaped: ShapedBlastSymbol = {
        symbol: d.symbol,
        file: declaredIn?.file ?? '',
        callers: d.callers.slice(0, MAX_BLAST_CALLERS).map((c) => `${c.file}:${c.line}`),
        caller_total: d.caller_total ?? d.callers.length,
      };
      const at = (list: typeof d.endpoints_affected, direct: boolean) =>
        list.filter((e) => (direct ? e.depth <= 1 : e.depth > 1)).map((e) => e.endpoint);

      const endpoints = at(d.endpoints_affected, true);
      const crons = at(d.crons_affected, true);
      const endpointsIndirect = at(d.endpoints_affected, false);
      const cronsIndirect = at(d.crons_affected, false);

      if (endpoints.length > 0) shaped.endpoints = endpoints;
      if (crons.length > 0) shaped.crons = crons;
      if (endpointsIndirect.length > 0) shaped.endpoints_indirect = endpointsIndirect;
      if (cronsIndirect.length > 0) shaped.crons_indirect = cronsIndirect;
      return shaped;
    });

  const shaped: ShapedBlast = {
    index_status: b.index.status,
    summary: b.summary,
    changed_symbols: b.changed_symbols.length,
    symbols,
    impacted_endpoints: b.impacted_endpoints,
    impacted_crons: b.impacted_crons,
  };

  if (b.index.status === 'partial' || b.index.status === 'failed') {
    shaped.caveat =
      'The repo index is incomplete, so callers or endpoints may be missing. ' +
      'Treat an empty result as "not known", not as "nothing is affected".';
  }
  return shaped;
}
