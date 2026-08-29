import type { FeatureModelChoice } from '@devdigest/shared';

/**
 * How many top-ranked files `repoIntel.getConventionSamples` is asked for.
 * That call returns PATHS ONLY — the extractor reads each file off the clone
 * itself — so this is a file count, not a token budget.
 */
export const SAMPLE_FILE_COUNT = 12;

/** Max lines read from any one sampled file, so one huge file can't crowd out the rest. */
export const MAX_LINES_PER_FILE = 160;

/** Upper bound on the assembled sample block handed to the model. */
export const MAX_SAMPLE_CHARS = 60_000;

/**
 * Module default when the workspace has NOT set a `conventions` feature model.
 * Deliberately a cheap OpenRouter model rather than the registry default
 * (`openai/gpt-5.4`): extraction is a bulk, low-stakes summarisation pass whose
 * output is then verified line-by-line against the clone, so paying frontier
 * prices buys nothing the grounding gate doesn't already enforce.
 *
 * This is why the module calls `getFeatureModelOverride` rather than
 * `resolveFeatureModel` — the latter would substitute the registry default and
 * silently discard this one.
 */
export const DEFAULT_CONVENTIONS_MODEL: FeatureModelChoice = {
  provider: 'openrouter',
  model: 'deepseek/deepseek-v4-flash',
};

/** Lines of slack either side of the cited line when matching a snippet. */
export const SNIPPET_MATCH_WINDOW = 3;

export const EXTRACT_TIMEOUT_MS = 120_000;
export const EXTRACT_MAX_RETRIES = 2;
