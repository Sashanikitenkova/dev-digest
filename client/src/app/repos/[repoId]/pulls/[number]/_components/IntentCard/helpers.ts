import type { IconName } from "@devdigest/ui";
import type { Risk, RiskSeverity } from "@devdigest/shared";
import type { IntentConfidence, IntentSource, PrIntentRecord } from "../../../../../../../lib/types";

/** Confidence bar colour. Low is deliberately muted, not alarming — a low-
    confidence intent is a normal outcome for a PR with no description. */
export function confidenceColor(level: IntentConfidence | null | undefined): string {
  if (level === "high") return "var(--ok)";
  if (level === "medium") return "var(--warn)";
  return "var(--text-muted)";
}

/** `linked_issue #42` / `spec_file docs/plan.md` / `title` — the chip's label. */
export function sourceLabel(source: IntentSource): string {
  return source.ref ? `${source.kind} ${source.ref}` : source.kind;
}

/**
 * The intent was derived from a commit that is no longer the PR's head, so the
 * scope on screen may not describe what is currently under review.
 */
export function isStale(intent: PrIntentRecord, headSha: string | null | undefined): boolean {
  if (!headSha || !intent.head_sha) return false;
  return intent.head_sha !== headSha;
}

/** Risk chip accent. Medium is the common case, so it stays visually quiet. */
export function riskColor(severity: RiskSeverity): string {
  if (severity === "high") return "var(--crit)";
  if (severity === "medium") return "var(--warn)";
  return "var(--text-muted)";
}

/** Icon per risk kind, falling back to a generic warning for future rules. */
export function riskIcon(risk: Risk): IconName {
  const byKind: Record<string, IconName> = {
    auth_surface: "Shield",
    secrets_handling: "Lock",
    new_dependency: "Boxes",
    db_migration: "Database",
    ci_workflow: "Workflow",
  };
  return byKind[risk.kind] ?? "AlertTriangle";
}

export function splitSources(sources: IntentSource[]): {
  used: IntentSource[];
  missing: IntentSource[];
} {
  return {
    used: sources.filter((s) => s.status === "used"),
    missing: sources.filter((s) => s.status === "missing"),
  };
}
