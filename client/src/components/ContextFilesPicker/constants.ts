/** Max width of the picker block, matching the editor tabs it sits inside. */
export const PICKER_MAX_WIDTH = 860;

/** Width of the "Attach document" dropdown menu. */
export const ATTACH_MENU_WIDTH = 420;

/** Width of the read-only preview modal. */
export const PREVIEW_MODAL_WIDTH = 820;

/**
 * Soft advisory ceiling, in approximate tokens, past which the picker warns.
 *
 * Mirrors the server's CONTEXT_TOKEN_WARN_THRESHOLD. It WARNS and nothing more:
 * no document is capped, truncated or dropped at this number. The figure comes
 * from an unexplained slow review with several skill blocks attached, not from
 * a measurement — treating it as a budget would silently withhold a rule the
 * author deliberately attached.
 */
export const TOKEN_WARN_THRESHOLD = 20_000;
