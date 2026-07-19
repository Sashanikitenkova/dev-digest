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

/** Case-insensitive filter over a skill's name + description + type. */
export function filterSkills(skills: Skill[], search: string): Skill[] {
  const q = search.trim().toLowerCase();
  if (!q) return skills;
  return skills.filter((sk) => `${sk.name} ${sk.description} ${sk.type}`.toLowerCase().includes(q));
}
