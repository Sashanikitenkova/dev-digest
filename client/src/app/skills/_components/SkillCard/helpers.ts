import type { Skill, SkillSource } from "@devdigest/shared";
import { TYPE_COLORS, UNTRUSTED_SOURCES } from "./constants";

/** Badge colour for a skill type (falls back to the muted secondary tone). */
export function typeColor(type: string): string {
  return TYPE_COLORS[type] ?? "var(--text-secondary)";
}

/**
 * Only `manual` bodies are trusted instructions. Everything else is wrapped in
 * `<untrusted source="skill:…">` at review time and arrives disabled — the card
 * flags it so an author knows to vet before enabling.
 */
export function isUntrusted(source: SkillSource): boolean {
  return (UNTRUSTED_SOURCES as readonly string[]).includes(source);
}

/**
 * A 0..1 rate as a whole-number percentage string, or null when there is none.
 *
 * The null is carried through rather than defaulted to "0" so the caller can
 * pick a different sentence entirely — "— pull" says "not measured", where
 * "0% pull" would claim the skill was offered and never used.
 */
export function formatCardRate(rate: number | null): string | null {
  if (rate === null) return null;
  return String(Math.round(rate * 100));
}

/** Case-insensitive filter over a skill's name + description + type. */
export function filterSkills(skills: Skill[], search: string): Skill[] {
  const q = search.trim().toLowerCase();
  if (!q) return skills;
  return skills.filter((sk) => `${sk.name} ${sk.description} ${sk.type}`.toLowerCase().includes(q));
}
