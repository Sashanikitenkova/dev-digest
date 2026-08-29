/**
 * Tunables for the blast-radius view. These bound the RESPONSE, not the index —
 * the facade is already bounded internally; these keep one wide-fan-out symbol
 * from turning the panel into an unreadable wall.
 */

/**
 * Callers listed per changed symbol (highest file-rank first). Matches the
 * facade's own per-symbol query cap, so this is a display guarantee rather than
 * a second, looser truncation that could never actually bind.
 */
export const MAX_CALLERS_PER_SYMBOL = 20;

/** Prior PRs shown in the "touching these files" disclosure. */
export const MAX_PRIOR_PRS = 5;
