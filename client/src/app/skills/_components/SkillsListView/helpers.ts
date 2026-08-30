import type { Skill } from "@devdigest/shared";

/** Resolve the currently previewed skill from the live list (id may be stale). */
export function selectedSkill(skills: Skill[], id: string | null): Skill | null {
  if (!id) return null;
  return skills.find((sk) => sk.id === id) ?? null;
}
