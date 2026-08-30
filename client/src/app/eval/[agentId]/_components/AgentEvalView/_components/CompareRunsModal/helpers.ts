export type DiffLine = { text: string; kind: "same" | "added" | "removed" };

/**
 * A line-level diff of two system prompts.
 *
 * Deliberately a set difference rather than a real LCS: the question the compare
 * modal answers is "which instructions did I add or remove", and for a prompt of
 * a few dozen lines that reads identically while staying dependency-free and
 * trivially testable. Reordering a line shows as neither added nor removed,
 * which is the right answer — the model sees the same instruction either way.
 */
export function diffPromptLines(before: string, after: string): DiffLine[] {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const beforeSet = new Set(beforeLines.map((l) => l.trim()));
  const afterSet = new Set(afterLines.map((l) => l.trim()));

  const out: DiffLine[] = [];
  for (const line of beforeLines) {
    if (!afterSet.has(line.trim())) out.push({ text: line, kind: "removed" });
  }
  for (const line of afterLines) {
    out.push({ text: line, kind: afterSet.has(line.trim()) && !beforeSet.has(line.trim()) ? "added" : "same" });
  }
  return out;
}
