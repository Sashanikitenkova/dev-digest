/** Constants for the skills module. */

/** Version recorded for a newly-created skill (first `skill_versions` row). */
export const INITIAL_SKILL_VERSION = 1;

/** Default skill type when neither the caller nor frontmatter says otherwise. */
export const DEFAULT_SKILL_TYPE = 'custom' as const;

/** Default source for a skill created without an explicit one. */
export const DEFAULT_SKILL_SOURCE = 'manual' as const;

/**
 * Max size of the JSON body accepted by `POST /skills/import/preview`.
 * Base64 inflates by ~4/3, so this holds a ~6 MB archive. Set per-route (the
 * app-wide default is 1 MB) so no other endpoint gets a wider door.
 */
export const IMPORT_BODY_LIMIT_BYTES = 8 * 1024 * 1024;
