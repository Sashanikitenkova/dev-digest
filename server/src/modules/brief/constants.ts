/**
 * Tunables for the Why + Risk brief (SPEC-02).
 *
 * Three groups, and the distinction between them matters:
 *
 *   1. BUDGET AND CALL — what one generation is allowed to cost. The token
 *      budget covers the COMPLETE model input (system message + user message +
 *      the serialized JSON schema), not just the user message; see `budget.ts`.
 *   2. OUTPUT SHAPE — what the model is allowed to return (`prompt.ts`).
 *   3. INPUT BOUNDS — the bounded representation of every section the shedding
 *      order protects, so the protected floor is FINITE for any pull request
 *      (AC-60). Without these a single pathological PR title or risk-scan
 *      result could exceed the whole budget on its own and the shedding loop
 *      would spin without ever fitting.
 *
 * `MAX_BODY_CHARS`, `MAX_ISSUE_CHARS`, `MAX_FILES_IN_PROMPT` and
 * `MAX_HUNKS_PER_FILE` are deliberately NOT re-declared here — the NFRs say
 * "matching" the intent classifier's values, so they are imported from
 * `../intent/constants.js` at their use sites and cannot drift.
 */

// ---------------------------------------------------------- budget and call

/** The COMPLETE model input ceiling: system + user + serialized schema. */
export const BRIEF_TOKEN_BUDGET = 8_000;

/**
 * Completion cap handed to the provider as `maxTokens`.
 *
 * This is NOT the size of the answer. On a reasoning model the reasoning
 * tokens come out of this same budget, BEFORE a single character of content —
 * so a cap sized for the answer alone yields empty content, `finish_reason:
 * 'length'`, and a schema-validation failure three retries later. It never
 * looks like truncation, and no LLM-mocking test can see it.
 *
 * Measured against the shipped default (`openrouter/deepseek-v4-pro`) with this
 * feature's real schema and a 40-file prompt:
 *
 *   1_200  →  reasoning consumed all 1_200, content empty, FAILED 3/3
 *   4_000  →  finish `stop`, parsed, $0.0052
 *
 * `deepseek-v4-flash` behaves the same way (1_200 fails 3/3; at 4_000 it spends
 * 1_430 on reasoning and 2_938 in total — the worst case observed, and the
 * number this cap is sized against). OpenRouter's `reasoning.exclude` only
 * HIDES the tokens rather than saving them, and `reasoning.effort: 'low'`
 * merely reduces them — neither makes 1_200 workable.
 *
 * Do not lower this without re-measuring against a live reasoning model.
 * `brief-budget.test.ts` guards the floor.
 */
export const BRIEF_MAX_COMPLETION_TOKENS = 4_000;

/** Per-attempt timeout. One bounded call with a user waiting on it. */
export const BRIEF_TIMEOUT_MS = 60_000;

/** Structured-output reprompts the provider may make before giving up. */
export const BRIEF_MAX_RETRIES = 2;

/** `response_format.json_schema.name`, and the memo key of the schema string. */
export const BRIEF_SCHEMA_NAME = 'risk_brief';

/**
 * Per-message allowance for the chat envelope (`role`, `content`, the JSON
 * framing the SDK adds around each message). Deliberately conservative: the
 * gate must OVER-count rather than under-count, because under-counting is the
 * failure mode that sends more than the budget claims.
 */
export const MESSAGE_ENVELOPE_TOKENS = 8;

// ------------------------------------------------------------- output shape

/** Risks a brief may carry. */
export const MAX_RISKS = 10;

/** Review-focus items a brief may carry. */
export const MAX_FOCUS_ITEMS = 8;

/** Per-risk and per-focus one-line summary cap. */
export const MAX_SUMMARY_CHARS = 200;

/** `what` cap. */
export const MAX_WHAT_CHARS = 400;

/** `why` cap. */
export const MAX_WHY_CHARS = 400;

// ------------------------------------------------------------- input bounds
// AC-60: every section the AC-14 shedding order PROTECTS carries its own
// bounded representation, established before assembly. These are the bounds.

/** PR title. */
export const MAX_TITLE_CHARS = 300;

/** Author, branch and base — one bound each, same value. */
export const MAX_REF_CHARS = 200;

/** Per changed-file path. The COUNT is bounded by `MAX_FILES_IN_PROMPT` (80). */
export const MAX_PATH_CHARS = 400;

/** Entries kept from the deterministic risk-area scan. */
export const MAX_RISK_AREAS = 40;

/** Per rendered risk-area entry. */
export const MAX_RISK_AREA_CHARS = 200;

/** The stored L03 intent sentence. */
export const MAX_INTENT_CHARS = 1_200;

/** Entries kept from each of the intent's in-scope / out-of-scope lists. */
export const MAX_SCOPE_ITEMS = 20;

/** Per in-scope / out-of-scope entry. */
export const MAX_SCOPE_ITEM_CHARS = 160;

/** Blast-derived changed-symbol labels kept. */
export const MAX_BLAST_SYMBOLS = 40;

/** Blast-derived impacted-endpoint strings kept. */
export const MAX_BLAST_ENDPOINTS = 40;

/**
 * Per blast-derived string: the summary sentence, each symbol label and each
 * endpoint. One bound for every text the blast radius contributes, so no
 * single index-derived value can dominate the protected floor.
 */
export const MAX_ENTITY_CHARS = 200;

/**
 * Project-context document PATHS forwarded to the model.
 *
 * There is deliberately NO cap on how many agents are resolved. Capping agents
 * (an earlier design) dropped resolved input silently, made the AC-15 ledger
 * false, and capped the wrong thing: resolving an agent is a handful of DB
 * reads (`ContextService.resolveForRun` is repository calls only), while the
 * token cost is in the PATHS. So every enabled agent is resolved, the union of
 * paths is deduplicated, sorted lexicographically ascending, and only then
 * truncated to this many — with a ledger entry naming the cap and the original
 * count (AC-62). Sorting BEFORE capping is what makes the selection
 * deterministic despite `AgentsRepository.listEnabled` having no `ORDER BY`.
 */
export const MAX_CONTEXT_PATHS = 40;
