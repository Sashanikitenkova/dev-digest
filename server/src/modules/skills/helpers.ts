import type { Skill, SkillType } from '@devdigest/shared';
import { SkillType as SkillTypeSchema } from '@devdigest/shared';
import type { SkillRow, SkillVersionRow } from '../../db/rows.js';
import { DEFAULT_SKILL_TYPE, STATS_WINDOW_DAYS } from './constants.js';

/**
 * Pure helpers for the skills module — DB row ⇄ DTO mapping, the
 * version-bump rule, and markdown parsing for imports. No I/O.
 */

/** Map a persisted skill row to the public `Skill` DTO. */
export function toSkillDto(row: SkillRow): Skill {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    type: row.type as SkillType,
    source: row.source,
    body: row.body,
    enabled: row.enabled,
    version: row.version,
    evidence_files: row.evidenceFiles ?? null,
  };
}

/** A single immutable body snapshot, as returned by `/skills/:id/versions`. */
export interface SkillVersionDto {
  skill_id: string;
  version: number;
  body: string;
  created_at: string;
}

export function toSkillVersionDto(row: SkillVersionRow): SkillVersionDto {
  return {
    skill_id: row.skillId,
    version: row.version,
    body: row.body,
    created_at: row.createdAt.toISOString(),
  };
}

// ---- stats ------------------------------------------------------------------

/** Start of the rolling stats window. Pure given a clock; injectable for tests. */
export function statsWindowStart(now: Date = new Date()): Date {
  return new Date(now.getTime() - STATS_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * A rate in 0..1, or **null when the denominator is zero**.
 *
 * The null matters: "no run has used this skill yet" and "this skill was
 * offered and never pulled" are different facts, and rendering both as 0%
 * would assert the second when only the first is known. The UI shows `—` for
 * null and a real percentage otherwise.
 */
export function ratio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return numerator / denominator;
}

/** Per-category finding rows collapsed into the totals the Stats tab shows. */
export function summariseFindings(
  rows: { category: string; total: number; accepted: number; dismissed: number }[],
): {
  total: number;
  accepted: number;
  dismissed: number;
  byCategory: { category: string; count: number }[];
} {
  let total = 0;
  let accepted = 0;
  let dismissed = 0;
  for (const r of rows) {
    total += r.total;
    accepted += r.accepted;
    dismissed += r.dismissed;
  }
  // Biggest slice first so the donut's legend reads in rank order.
  const byCategory = rows
    .map((r) => ({ category: r.category, count: r.total }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
  return { total, accepted, dismissed, byCategory };
}

/**
 * True when a patch actually changes the skill's `body`.
 *
 * Deliberately narrower than the agents module's `isConfigChange`: a
 * `skill_versions` row carries only `body`, so bumping the version on a
 * name/description/type/enabled edit would append a snapshot indistinguishable
 * from the previous one.
 */
export function isBodyChange(
  existing: Pick<SkillRow, 'body'>,
  patch: { body?: string },
): boolean {
  return patch.body !== undefined && patch.body !== existing.body;
}

/** What `parseSkillMarkdown` recovers from an uploaded markdown document. */
export interface ParsedSkillMarkdown {
  name: string;
  description: string;
  type: SkillType;
  /** The document with any YAML frontmatter block removed. */
  body: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const HEADING = /^#{1,6}\s+(.+?)\s*$/m;

/** Parse the leading `---` YAML block as flat `key: value` pairs (no nesting,
 *  no lists — a skill's frontmatter is metadata, not a config language). */
function parseFrontmatter(text: string): { data: Record<string, string>; body: string } {
  const match = FRONTMATTER.exec(text);
  if (!match) return { data: {}, body: text };
  const data: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const sep = line.indexOf(':');
    if (sep <= 0 || line.trimStart().startsWith('#')) continue;
    const key = line.slice(0, sep).trim().toLowerCase();
    const value = line
      .slice(sep + 1)
      .trim()
      .replace(/^["'](.*)["']$/, '$1');
    if (key && value) data[key] = value;
  }
  return { data, body: text.slice(match[0].length) };
}

/** Strip a path + extension down to a bare stem: `a/b/SKILL.md` → `SKILL`. */
export function filenameStem(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  return base.replace(/\.[^.]+$/, '') || base;
}

/** First non-empty, non-heading, non-fence paragraph of a markdown body. */
function firstParagraph(body: string): string {
  const lines = body.split(/\r?\n/);
  const collected: string[] = [];
  let inFence = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      inFence = !inFence;
      if (collected.length) break;
      continue;
    }
    if (inFence) continue;
    if (!trimmed) {
      if (collected.length) break;
      continue;
    }
    if (/^#{1,6}\s/.test(trimmed) || /^([-*_])\1{2,}$/.test(trimmed)) {
      if (collected.length) break;
      continue;
    }
    collected.push(trimmed);
  }
  return collected.join(' ');
}

/**
 * Derive a skill's metadata from an uploaded markdown document.
 *
 * - `name`: frontmatter `name:` → first markdown heading → the filename stem.
 * - `description`: frontmatter `description:` → first prose paragraph → ''.
 * - `type`: frontmatter `type:` when it is a valid `SkillType`, else `custom`.
 * - `body`: the document with the frontmatter block removed.
 */
export function parseSkillMarkdown(text: string, filename: string): ParsedSkillMarkdown {
  const { data, body: raw } = parseFrontmatter(text);
  const body = raw.replace(/^\s*\r?\n/, '').trimEnd();

  const heading = HEADING.exec(body)?.[1]?.trim();
  const name = data.name || heading || filenameStem(filename);

  const description = data.description || firstParagraph(body);

  const parsedType = SkillTypeSchema.safeParse(data.type);
  const type = parsedType.success ? parsedType.data : DEFAULT_SKILL_TYPE;

  return { name, description, type, body };
}
