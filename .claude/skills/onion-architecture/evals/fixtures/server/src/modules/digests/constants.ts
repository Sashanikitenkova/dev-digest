/** Tunables for digest building, kept out of the service so tests can read them. */

export const DEFAULT_PERIOD_DAYS = 7;

/** A digest over more than this many PRs stops being readable, so we truncate. */
export const MAX_PRS_PER_DIGEST = 40;

export const DIGEST_MODEL = 'anthropic/claude-3.5-haiku';

export const DIGEST_SYSTEM_PROMPT =
  'Summarise this merged pull request in at most two sentences, written for a ' +
  'teammate who did not review it. Lead with the user-visible effect.';

/** How many remembered items ride along at the end of a digest. */
export const RELATED_MEMORY_LIMIT = 5;
