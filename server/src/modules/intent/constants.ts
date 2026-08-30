/**
 * Tunables for the intent classifier (call 1 of a review run).
 *
 * Everything here bounds what reaches a cheap model: how much author-controlled
 * text is forwarded, how many files are listed, and which repo paths may be
 * read off the clone at all. The classifier NEVER sees diff bodies — only file
 * names and `@@` hunk headers (see `helpers.renderHunkHeaders`).
 */

/** Per-attempt timeout for the classifier call. One bounded call, user waiting. */
export const DETECT_TIMEOUT_MS = 60_000;

/** Structured-output reprompts before we give up and return `undefined`. */
export const DETECT_MAX_RETRIES = 2;

/**
 * Below this many characters a PR description is still SENT to the classifier
 * (it is context, and withholding it would only make the guess worse) but is
 * recorded as a `missing` source with reason `body_too_short`, so it cannot
 * raise the deterministic confidence ceiling. See `computeConfidence`.
 */
export const MIN_BODY_CHARS = 120;

/** Hard cap on the PR body forwarded to the classifier. */
export const MAX_BODY_CHARS = 6_000;

/** Hard cap on a linked issue's body. */
export const MAX_ISSUE_CHARS = 4_000;

/** How many repo-relative spec/plan docs may be read off the clone. */
export const MAX_SPEC_FILES = 2;

/** Per-spec-file character cap. */
export const MAX_SPEC_CHARS = 8_000;

/**
 * How many doc-path candidates we even consider before the safety gate. Bounds
 * the work a hostile PR body can create; the survivors are then capped again by
 * `MAX_SPEC_FILES`.
 */
export const MAX_SPEC_CANDIDATES = 8;

/** External links recorded (as `missing`) — never fetched; see the module doc. */
export const MAX_URL_SOURCES = 5;

/** Changed files listed with their hunk headers. */
export const MAX_FILES_IN_PROMPT = 80;

/** Hunk headers rendered per file (the rest are summarised as a count). */
export const MAX_HUNKS_PER_FILE = 12;

/** Extensions a body-referenced path must carry to be read off the clone. */
export const SPEC_EXTENSIONS: readonly string[] = ['.md', '.mdx', '.txt', '.rst'];

/** Path-traversal gate limits (see `safeRepoRelativePath`). */
export const MAX_PATH_LENGTH = 200;
export const MAX_PATH_DEPTH = 6;

/** Scope entries kept from the model's answer, and the per-entry length cap. */
export const MAX_SCOPE_ENTRIES = 12;
export const MAX_SCOPE_ENTRY_CHARS = 200;
/** Cap on the one-sentence intent statement. */
export const MAX_INTENT_CHARS = 600;

/**
 * MODEL CHOICE — the registry default for `review_intent` is a cheap
 * OpenRouter model (`platform.ts`), resolved through `resolveFeatureModel` so a
 * workspace override wins. Two things to know before changing it:
 *
 * 1. OpenRouter documents that some upstream providers treat a JSON schema as
 *    "a strong hint" rather than a constraint. Prefer models advertising
 *    `supported_parameters=structured_outputs`. `completeStructured` reprompts
 *    (`DETECT_MAX_RETRIES`) and the service degrades to `undefined` on the
 *    final miss rather than failing a review run.
 * 2. Reference pricing per 1M tokens (in/out), for scale only — do NOT hardcode
 *    a model allowlist:
 *      Gemini 2.5 Flash-Lite  $0.10 / $0.40
 *      DeepSeek V3.2         ≈$0.21 / $0.32
 *      GPT-5 mini             $0.25 / $2.00
 *      Gemini 2.5 Flash       $0.30 / $2.50
 *      GPT-4.1 mini           $0.40 / $1.60
 *    If schema misses show up on DeepSeek, Flash-Lite is the fallback.
 */
export const MODEL_NOTE =
  'review_intent resolves through resolveFeatureModel; prefer models advertising structured_outputs.';
