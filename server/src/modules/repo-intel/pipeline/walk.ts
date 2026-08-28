/**
 * repo-intel pipeline — walk + filter (step 1+2).
 *
 * Walks a clone directory and returns the set of files the parse phase should
 * process, applying:
 *   - EXCLUDED_DIRS  (node_modules, dist, build, coverage, .next, out, vendor, .git)
 *   - SUPPORTED_EXT  (.ts, .tsx, .js, .jsx, .mjs, .cjs)
 *   - MAX_FILE_SIZE  (400 KB) — files larger than this are counted in
 *                    `stats.skippedTooLarge` and left out of the result.
 *   - MAX_INDEXED_FILES (5000) — if exceeded, take the FIRST N (by walk order)
 *                    and record `stats.bounded = total - N`. T3 will replace
 *                    "first N" with "top N by hotness" once `file_rank` lands.
 *
 * NOT YET HANDLED:
 *   - `.gitignore` filtering. Would require the `ignore` npm package; the
 *     EXCLUDED_DIRS list covers the heaviest dirs (node_modules, build outputs),
 *     so the practical loss is small. TODO(T3): wire `ignore` once we accept
 *     a new dep, OR honor `git ls-files` so we get .gitignore for free.
 *
 * Pure-ish: takes a root path + does fs ops; returns plain data so the caller
 * (full.ts / incremental.ts) can decide what to do with it.
 *
 * SPEC-01: an optional second argument (`WalkOptions`) lets a non-indexer
 * caller swap the extension set and prune directories — the project-context
 * discovery walk uses it to collect `.md` under the configured roots. The
 * exclusions, the symlink rule and both budgets are shared, not re-declared.
 */
import { readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import {
  EXCLUDED_DIRS,
  MAX_FILE_SIZE,
  MAX_INDEXED_FILES,
  SUPPORTED_EXT,
} from '../constants.js';

const EXCLUDED_SET: ReadonlySet<string> = new Set(EXCLUDED_DIRS);
const SUPPORTED_SET: ReadonlySet<string> = new Set(SUPPORTED_EXT);

export interface WalkStats {
  /** Files seen on disk with a SUPPORTED_EXT extension (before size + bound filters). */
  totalCandidates: number;
  /** Candidates dropped because stat().size > MAX_FILE_SIZE. */
  skippedTooLarge: number;
  /** Candidates dropped because the file list exceeded MAX_INDEXED_FILES. */
  bounded: number;
}

export interface WalkResult {
  /** Paths relative to `root`, separator-normalized to forward slashes. */
  files: string[];
  stats: WalkStats;
}

/**
 * Optional overrides (SPEC-01). Both default to today's indexer behaviour, so
 * `walkClone(root)` is byte-identical to the pre-SPEC-01 function and the two
 * existing callers (`pipeline/full.ts`, `pipeline/incremental.ts`) are untouched.
 *
 * Overriding these does NOT relax any safety or budget rule: EXCLUDED_DIRS is
 * still applied on top of `dirFilter`, symlinks are still never followed, and
 * MAX_FILE_SIZE / MAX_INDEXED_FILES still bound the result. That is the whole
 * reason the `.md` discovery walk extends this function instead of forking a
 * second walker that would have to re-earn those guarantees.
 */
export interface WalkOptions {
  /** Lower-cased extensions to collect, INCLUDING the dot. Default: SUPPORTED_EXT. */
  extensions?: readonly string[];
  /**
   * Extra directory-name predicate, applied in ADDITION to EXCLUDED_DIRS —
   * return false to prune. Receives the directory's own name and its
   * root-relative path, so a caller can restrict the walk to configured
   * top-level roots without re-implementing the recursion.
   */
  dirFilter?: (name: string, relPath: string) => boolean;
}

/**
 * Recursively walk `root`, returning the file set to parse + a small stats
 * object the pipeline persists into `repo_index_state.stats`.
 */
export async function walkClone(root: string, options?: WalkOptions): Promise<WalkResult> {
  const out: string[] = [];
  const stats: WalkStats = { totalCandidates: 0, skippedTooLarge: 0, bounded: 0 };
  const extensions: ReadonlySet<string> = options?.extensions
    ? new Set(options.extensions.map((e) => e.toLowerCase()))
    : SUPPORTED_SET;

  await walkDir(root, root, out, stats, extensions, options?.dirFilter);

  // Stable order: alphabetical relpath. Keeps "first N when bounded" reproducible
  // across runs (until T3 replaces it with rank-driven selection).
  out.sort();

  if (out.length > MAX_INDEXED_FILES) {
    stats.bounded = out.length - MAX_INDEXED_FILES;
    out.length = MAX_INDEXED_FILES;
  }

  return { files: out, stats };
}

async function walkDir(
  root: string,
  dir: string,
  out: string[],
  stats: WalkStats,
  extensions: ReadonlySet<string>,
  dirFilter?: (name: string, relPath: string) => boolean,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = (await readdir(dir, { withFileTypes: true })) as Dirent[];
  } catch {
    // Unreadable directory (permissions, dangling symlink) — skip cleanly so
    // the indexer keeps making progress on the parts of the clone it CAN read.
    return;
  }

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue; // never follow symlinks (loops, perf)
    const name = entry.name;

    if (entry.isDirectory()) {
      // EXCLUDED_DIRS is checked FIRST and unconditionally: a caller-supplied
      // dirFilter can only ever narrow the walk, never re-admit node_modules.
      if (EXCLUDED_SET.has(name)) continue;
      const childDir = join(dir, name);
      if (dirFilter) {
        const rel = relative(root, childDir).split(sep).join('/');
        if (!dirFilter(name, rel)) continue;
      }
      await walkDir(root, childDir, out, stats, extensions, dirFilter);
      continue;
    }

    if (!entry.isFile()) continue;

    const ext = extname(name).toLowerCase();
    if (!extensions.has(ext)) continue;

    stats.totalCandidates += 1;

    const full = join(dir, name);
    let size: number;
    try {
      size = (await stat(full)).size;
    } catch {
      continue;
    }
    if (size > MAX_FILE_SIZE) {
      stats.skippedTooLarge += 1;
      continue;
    }

    // Posix-style relative path so DB rows are platform-agnostic (matches the
    // `pr_files.path` convention).
    const rel = relative(root, full).split(sep).join('/');
    out.push(rel);
  }
}
