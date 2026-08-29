import type { ConventionCandidate } from "@devdigest/shared";

/* Merge accepted conventions into one editable skill body.

   The generated markdown is a STARTING POINT the author edits before saving —
   it is never written back to the conventions rows, so re-running extraction
   can't clobber a skill someone has since hand-tuned. */

/** Slugify a repo name into a skill name: `acme/payments-api` → `payments-api-conventions`. */
export function skillNameForRepo(fullName: string | undefined): string {
  const short = (fullName ?? "repo").split("/").pop() ?? "repo";
  return `${short.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-conventions`;
}

/** `src/a.ts:12` or `src/a.ts:12-18` — the same range the evidence block shows. */
export function evidenceRange(path: string, line?: number | null, endLine?: number | null): string {
  if (!line) return path;
  return endLine && endLine > line ? `${path}:${line}-${endLine}` : `${path}:${line}`;
}

/**
 * Build the merged markdown body.
 *
 * Each rule keeps its evidence citation: a reviewer reading the skill can check
 * the rule against real code, and an agent quoting the rule inherits a concrete
 * `file:line` to point at rather than asserting a house style from nowhere.
 */
export function buildSkillBody(
  repoFullName: string | undefined,
  conventions: ConventionCandidate[],
): string {
  const name = skillNameForRepo(repoFullName);
  const lines: string[] = [
    `# ${name}`,
    "",
    `House conventions for \`${repoFullName ?? "this repo"}\`. Flag changes that violate any rule below and cite the offending \`file:line\`.`,
    "",
  ];

  for (const c of conventions) {
    lines.push(`## ${headingFor(c)}`);
    lines.push(c.rule);
    lines.push("");
    if (c.evidence_path) {
      lines.push(`Detected in \`${evidenceRange(c.evidence_path, c.evidence_line)}\`:`);
      lines.push("");
      lines.push("```");
      lines.push(c.evidence_snippet.trim());
      lines.push("```");
      lines.push("");
    }
  }
  return lines.join("\n").trimEnd() + "\n";
}

/** A stable kebab heading per rule, derived from category + the rule's opening words. */
function headingFor(c: ConventionCandidate): string {
  const words = c.rule
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
    .join("-");
  return c.category ? `${c.category}-${words}`.slice(0, 60) : words.slice(0, 60);
}
