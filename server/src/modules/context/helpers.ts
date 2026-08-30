import { approxTokens } from '../../adapters/tokenizer/index.js';
import { safeRepoRelativePath } from '../intent/helpers.js';
import { CONTEXT_EXTENSIONS } from './constants.js';

/**
 * Pure helpers for the project-context module (SPEC-01): which repo paths may
 * be read, what type a document is, and how several attachment sets merge into
 * one ordered list.
 *
 * No container and no I/O, following the intent module's split — which matters
 * because `safeContextPath` is a security boundary and must be unit-testable
 * on its own, without a clone or a database.
 */

/** Approximate tokens for a document body — `ceil(chars/4)`.
 *
 * Uses the tokenizer adapter's HEURISTIC, not `container.tokenizer` (the
 * tiktoken encoder), on purpose: the client shows the same estimate from
 * `lib/tokens.ts`, which computes `ceil(chars/4)` in the browser with no
 * encoder available. A real BPE count here would make the picker's number and
 * the trace's number disagree for every document, and the value is only ever
 * used as an order-of-magnitude budget hint. */
export function contextTokens(content: string): number {
  return approxTokens(content);
}

/**
 * The type badge for a document: the configured root it was found under.
 *
 * The FIRST path segment that matches a configured root wins, so
 * `docs/specs/x.md` is a `docs` document and never both — a document with two
 * types would double-count in every per-type total. Returns `null` when the
 * path sits under no configured root, which is what a stale attachment looks
 * like after `DEVDIGEST_CONTEXT_ROOTS` changes.
 */
export function documentType(path: string, roots: readonly string[]): string | null {
  const first = path.split('/')[0];
  if (!first) return null;
  return roots.includes(first) ? first : null;
}

/**
 * The path-traversal gate for project-context reads.
 *
 * Delegates to the intent module's `safeRepoRelativePath` — the same allowlist,
 * depth and length rules, so there is ONE containment implementation in the
 * server — then narrows the extension to `.md` alone. Reusing
 * `safeRepoRelativePath` unmodified would admit `.mdx`/`.txt`/`.rst`, which the
 * preview cannot render and this feature does not support.
 *
 * Returns the normalized repo-relative path, or `null` when the input must not
 * be handed to `GitClient.readFile` (which joins onto the clone dir with no
 * containment check of its own).
 */
export function safeContextPath(input: string): string | null {
  const safe = safeRepoRelativePath(input);
  if (!safe) return null;
  const dot = safe.lastIndexOf('.');
  const ext = dot === -1 ? '' : safe.slice(dot).toLowerCase();
  return CONTEXT_EXTENSIONS.includes(ext) ? safe : null;
}

/** One skill's attached paths, in the order that skill's link carries. */
export interface SkillPathGroup {
  skillId: string;
  paths: string[];
}

/**
 * Merge an agent's own attachments with those inherited from its enabled
 * skills into ONE ordered, duplicate-free list.
 *
 * Order: the agent's own documents first, then each skill's group in
 * `agent_skills.order` (the caller passes the groups already sorted). A path
 * attached in several places is emitted ONCE, at its EARLIEST position — the
 * document is one block in the prompt either way, and emitting it twice would
 * bill the same tokens twice and let a later, lower-priority attachment move a
 * deliberately-first document down the prompt.
 */
export function mergeAttachments(
  agentPaths: readonly string[],
  skillPathGroups: readonly SkillPathGroup[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (p: string) => {
    if (seen.has(p)) return;
    seen.add(p);
    out.push(p);
  };
  for (const p of agentPaths) push(p);
  for (const group of skillPathGroups) for (const p of group.paths) push(p);
  return out;
}
