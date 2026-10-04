import type { FindingRecord } from "@devdigest/shared";

/** Format a finding's line range ("11" when single-line, else "11-15"). */
export function lineLabel(f: Pick<FindingRecord, "start_line" | "end_line">): string {
  return f.start_line === f.end_line ? `${f.start_line}` : `${f.start_line}-${f.end_line}`;
}

/** Render a finding as a Markdown snippet for pasting into a PR comment, Slack or a ticket. */
export function findingToMarkdown(
  f: Pick<
    FindingRecord,
    "severity" | "category" | "title" | "file" | "start_line" | "end_line" | "rationale" | "suggestion"
  >,
): string {
  const parts = [
    `**[${f.severity}] ${f.title}** · ${f.category}`,
    `\`${f.file}:L${lineLabel(f)}\``,
    f.rationale.trim(),
  ];
  if (f.suggestion?.trim()) parts.push(`**Suggested fix:**\n${f.suggestion.trim()}`);
  return parts.join("\n\n");
}
