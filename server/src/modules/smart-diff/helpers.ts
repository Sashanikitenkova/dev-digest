import type { ProposedSplit, SmartDiff, SmartDiffFile, SmartDiffGroup } from '@devdigest/shared';
import { classifyFile } from './classify.js';
import type { ChangedFileRow, FindingLineRow } from './repository.js';
import {
  LARGE_PR_LINES,
  MAX_PROPOSED_SPLITS,
  MIN_FILES_PER_SPLIT,
  SMART_DIFF_ROLE_ORDER,
} from './constants.js';

/**
 * Pure composition of the SmartDiff response: classify → group → attach finding
 * lines → derive the split suggestion. No DB, no model, no clock — everything
 * here is a function of its arguments, which is what makes it unit-testable.
 */

/** Finding start-lines per file, deduped and ascending. */
function findingLinesByPath(findings: FindingLineRow[]): Map<string, number[]> {
  const byPath = new Map<string, Set<number>>();
  for (const f of findings) {
    const set = byPath.get(f.file) ?? new Set<number>();
    set.add(f.startLine);
    byPath.set(f.file, set);
  }
  return new Map([...byPath].map(([path, lines]) => [path, [...lines].sort((a, b) => a - b)]));
}

/**
 * Group changed files by classified role.
 *
 * All three groups are emitted even when empty: the viewer renders a fixed
 * core → wiring → boilerplate layout, and a group that vanishes when it happens
 * to be empty makes the page jump between PRs.
 */
export function groupFiles(files: ChangedFileRow[], findings: FindingLineRow[]): SmartDiffGroup[] {
  const lines = findingLinesByPath(findings);

  const entries: { role: string; file: SmartDiffFile }[] = files.map((f) => ({
    role: classifyFile(f.path),
    file: {
      path: f.path,
      // Deliberately null: this field is an LLM-written summary, and Smart Diff
      // must not call a model. A later lesson fills it in.
      pseudocode_summary: null,
      additions: f.additions,
      deletions: f.deletions,
      finding_lines: lines.get(f.path) ?? [],
    },
  }));

  return SMART_DIFF_ROLE_ORDER.map((role) => ({
    role,
    files: entries.filter((e) => e.role === role).map((e) => e.file),
  }));
}

/** The top-level directory a path sits in — the split axis. */
function topLevelDir(path: string): string {
  const cut = path.indexOf('/');
  return cut === -1 ? '(root)' : path.slice(0, cut);
}

/**
 * Deterministic split suggestion for an oversized PR.
 *
 * Only CORE files are split on: proposing that someone carve out their lockfile
 * churn is noise, and the point of the suggestion is to break up the logic that
 * actually has to be reasoned about. Directories holding fewer than
 * MIN_FILES_PER_SPLIT files are left out rather than proposed as one-file PRs.
 */
export function buildSplitSuggestion(
  files: ChangedFileRow[],
  groups: SmartDiffGroup[],
): SmartDiff['split_suggestion'] {
  const totalLines = files.reduce((n, f) => n + f.additions + f.deletions, 0);
  const tooBig = totalLines > LARGE_PR_LINES;
  if (!tooBig) return { too_big: false, total_lines: totalLines, proposed_splits: [] };

  const corePaths = groups.find((g) => g.role === 'core')?.files.map((f) => f.path) ?? [];
  const byDir = new Map<string, string[]>();
  for (const path of corePaths) {
    const dir = topLevelDir(path);
    byDir.set(dir, [...(byDir.get(dir) ?? []), path]);
  }

  const proposed: ProposedSplit[] = [...byDir]
    .filter(([, paths]) => paths.length >= MIN_FILES_PER_SPLIT)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, MAX_PROPOSED_SPLITS)
    .map(([dir, paths]) => ({ name: dir, files: [...paths].sort() }));

  return { too_big: true, total_lines: totalLines, proposed_splits: proposed };
}

export function buildSmartDiff(files: ChangedFileRow[], findings: FindingLineRow[]): SmartDiff {
  const groups = groupFiles(files, findings);
  return { groups, split_suggestion: buildSplitSuggestion(files, groups) };
}
