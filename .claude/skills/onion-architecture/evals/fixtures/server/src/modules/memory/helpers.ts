import { DEDUPE_NORMALISE } from './constants.js';

/** Pure list shaping — no I/O, so it is unit-testable on its own. */

interface HasContent {
  content: string;
}

/**
 * Keeps the first occurrence of each distinct content. Near-duplicates are
 * common because the same decision gets remembered from several PRs, and a
 * search that returns the same sentence four times reads as broken.
 */
export function dedupeByContent<T extends HasContent>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const key = row.content.trim().toLowerCase().replace(DEDUPE_NORMALISE, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}
