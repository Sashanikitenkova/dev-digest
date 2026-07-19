import type { AgentSkillLink, Skill } from "@devdigest/shared";

/** One row of the Skills tab: a link joined to the skill it points at. */
export interface SkillRow {
  link: AgentSkillLink;
  /** Undefined if the skill list hasn't loaded (or the skill vanished). */
  skill: Skill | undefined;
}

/**
 * Links in prompt-block order, joined to their skill record.
 *
 * `order` — not array position from the API — is authoritative, because a
 * disabled link keeps its slot: that is exactly why order stays meaningful for
 * a linked-but-off skill.
 */
export function toRows(
  links: readonly AgentSkillLink[] | undefined,
  skills: readonly Skill[] | undefined,
): SkillRow[] {
  const byId = new Map((skills ?? []).map((sk) => [sk.id, sk]));
  return [...(links ?? [])]
    .sort((a, b) => a.order - b.order)
    .map((link) => ({ link, skill: byId.get(link.skill_id) }));
}

/** How many links are switched on — i.e. contribute a block to the prompt. */
export function countEnabled(rows: readonly SkillRow[]): number {
  return rows.filter((r) => r.link.enabled).length;
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

/** Case-insensitive match over the skill name/description; empty query matches all. */
export function matchesFilter(row: SkillRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = `${row.skill?.name ?? row.link.skill_id} ${row.skill?.description ?? ""}`;
  return hay.toLowerCase().includes(q);
}

/** Skills not yet linked to this agent — the "Link a skill" menu contents. */
export function unlinkedSkills(
  skills: readonly Skill[] | undefined,
  rows: readonly SkillRow[],
): Skill[] {
  const linked = new Set(rows.map((r) => r.link.skill_id));
  return (skills ?? []).filter((sk) => !linked.has(sk.id));
}

/** The `skill_ids` payload for `POST /agents/:id/skills` — array order IS block order. */
export function toSkillIds(rows: readonly SkillRow[]): string[] {
  return rows.map((r) => r.link.skill_id);
}
