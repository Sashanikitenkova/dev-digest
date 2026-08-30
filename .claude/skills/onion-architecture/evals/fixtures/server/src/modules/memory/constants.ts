/** Tunables for memory retrieval, kept out of the service so tests can read them. */

export const DEFAULT_SEARCH_LIMIT = 8;

/** Two items whose content matches after this normalisation are the same memory. */
export const DEDUPE_NORMALISE = /\s+/g;
