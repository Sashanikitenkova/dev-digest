/**
 * Project-context module constants (SPEC-01).
 *
 * Deliberately short: the discovery limits are NOT re-declared here. They are
 * imported from `modules/repo-intel/constants.ts` (MAX_FILE_SIZE,
 * MAX_INDEXED_FILES) and `modules/intent/constants.ts` (MAX_PATH_LENGTH,
 * MAX_PATH_DEPTH), so there is exactly one number per rule in the codebase and
 * a future change to the walker's budget cannot silently disagree with the
 * discovery walk's.
 */

/**
 * The ONLY extension a project-context document may carry.
 *
 * Narrower than the intent module's `SPEC_EXTENSIONS` (`.md .mdx .txt .rst`) on
 * purpose: these documents are rendered as markdown in a read-only preview and
 * assembled verbatim into a prompt, so admitting `.txt`/`.rst` would promise a
 * rendering the UI does not do. Widening this means widening the preview too.
 */
export const CONTEXT_EXTENSIONS: readonly string[] = ['.md'];

/**
 * Soft advisory ceiling for a single owner's attached documents, in approximate
 * tokens. Purely a WARNING threshold surfaced in the editor — nothing caps,
 * truncates or drops a document at this number.
 *
 * It is an observation about skill blocks that was never root-caused (see
 * server/INSIGHTS.md, "Why did the skills-on review run take 13 minutes"), NOT
 * a measured budget. Do not promote it into a cap without measuring first.
 */
export const CONTEXT_TOKEN_WARN_THRESHOLD = 20_000;
