import type { SmartDiffRole } from '@devdigest/shared';
import { CLASSIFICATION_RULES, DEFAULT_ROLE } from './constants.js';

/**
 * Deterministic file-role classifier — the whole of Smart Diff's "risk" signal.
 *
 * Pure and path-only: no I/O, no index lookup, and explicitly NO model call.
 * That is the point of the feature — it must produce an ordering the instant a
 * PR is imported, before any review has run.
 *
 * Additions/deletions are deliberately NOT an input. Size is a poor role signal
 * (a one-line change to a payment handler is core; a 900-line lockfile bump is
 * not), and mixing it in would make the classification unstable across the
 * diff-stat backfill in `GET /pulls/:id`. Size is used only for the split
 * suggestion, where it actually means something.
 */

/** Normalize to the POSIX, relative form the rules are written against. */
function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

export function classifyFile(path: string): SmartDiffRole {
  const normalized = normalizePath(path);
  for (const rule of CLASSIFICATION_RULES) {
    if (rule.test.test(normalized)) return rule.role;
  }
  return DEFAULT_ROLE;
}
