/** Constants for SkillCard. */

/** Accent colour per skill type — keeps the type badge scannable in the grid. */
export const TYPE_COLORS: Record<string, string> = {
  rubric: "var(--accent)",
  convention: "var(--sugg, var(--text-secondary))",
  security: "var(--crit)",
  custom: "var(--text-secondary)",
};

/** Sources whose bodies are treated as untrusted data, never as instructions. */
export const UNTRUSTED_SOURCES = ["imported_url", "community", "extracted"] as const;
