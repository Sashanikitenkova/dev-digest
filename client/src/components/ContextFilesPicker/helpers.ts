import type { SpecFile } from "@devdigest/shared";

/** One row of the picker: a discovered document plus whether it is attached. */
export interface DocRow {
  file: SpecFile;
  attached: boolean;
}

/**
 * Rows in ATTACHMENT order first (the order documents reach the prompt), then
 * every unattached document alphabetically.
 *
 * An attached path with no matching discovered file still produces a row, with
 * a synthesized `SpecFile` marked `type: ""`. That is the stale-attachment case
 * — the document was renamed or deleted in the repo — and it has to stay
 * visible: silently dropping it would hide the fact that a rule the author
 * believes is in force will be reported `not_in_clone` on the next review.
 */
export function toRows(files: readonly SpecFile[], attached: readonly string[]): DocRow[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const attachedSet = new Set(attached);
  const rows: DocRow[] = attached.map((path) => ({
    file: byPath.get(path) ?? { path, type: "", bytes: 0, tokens: 0, used_by_agents: 0 },
    attached: true,
  }));
  const rest = files
    .filter((f) => !attachedSet.has(f.path))
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file) => ({ file, attached: false }));
  return [...rows, ...rest];
}

/**
 * Reconcile an EXISTING row list against fresh data without moving anything.
 *
 * `toRows` groups attached documents first, which is the right thing on a fresh
 * mount — it shows the order the prompt will use. It is the wrong thing while
 * the author is clicking: attaching a document there moves it to index 0 and
 * shifts every row below it down, so a click on the third row leaves the
 * checkmark on the first and a different document sitting where the cursor is.
 * It reads as "I chose one document and it chose another", and the click was
 * never wrong — the list moved.
 *
 * So once rows exist, they keep their positions: a toggle flips a flag in
 * place, a document that vanished from the repo drops out, and a newly
 * discovered one joins at the end. Regrouping happens on the next mount.
 *
 * Display order stays the submitted order, because the caller derives the
 * payload from the visible rows — so the arrow buttons remain the only thing
 * that changes what the prompt gets.
 */
export function mergeRows(
  prev: readonly DocRow[],
  files: readonly SpecFile[],
  attached: readonly string[],
): DocRow[] {
  // Nothing to preserve yet — first mount gets the attached-first grouping.
  if (prev.length === 0) return toRows(files, attached);

  const byPath = new Map(files.map((f) => [f.path, f]));
  const attachedSet = new Set(attached);

  const kept: DocRow[] = [];
  const seen = new Set<string>();
  for (const row of prev) {
    const path = row.file.path;
    const discovered = byPath.get(path);
    const isAttached = attachedSet.has(path);
    // A row earns its place by being discovered OR attached. One that is
    // neither is genuinely gone: deleted from the repo and detached.
    if (!discovered && !isAttached) continue;
    seen.add(path);
    kept.push({
      // Prefer fresh metadata; fall back to the synthesized stale-attachment
      // shape so a detached-and-deleted document still renders while visible.
      file: discovered ?? row.file,
      attached: isAttached,
    });
  }

  // Anything discovered since the last reconcile, appended in a stable order
  // rather than inserted — inserting would move rows, which is the whole thing
  // this function exists to avoid.
  const added = files
    .filter((f) => !seen.has(f.path))
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file) => ({ file, attached: attachedSet.has(file.path) }));

  return [...kept, ...added];
}

/** Immutably move `from` → `to`, clamping both into range. */
export function moveItem<T>(arr: readonly T[], from: number, to: number): T[] {
  const next = [...arr];
  if (from < 0 || from >= next.length) return next;
  const target = Math.max(0, Math.min(next.length - 1, to));
  const moved = next.splice(from, 1);
  next.splice(target, 0, ...moved);
  return next;
}

/** Case-insensitive substring match over path and type; empty query matches all. */
export function matchesFilter(row: DocRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return `${row.file.path} ${row.file.type}`.toLowerCase().includes(q);
}

/** Approximate tokens contributed by the ATTACHED documents only. */
export function attachedTokens(rows: readonly DocRow[]): number {
  return rows.reduce((sum, r) => (r.attached ? sum + r.file.tokens : sum), 0);
}
