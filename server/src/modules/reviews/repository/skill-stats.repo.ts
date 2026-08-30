import { sql } from 'drizzle-orm';
import type { Db } from '../../../db/client.js';

/**
 * Read-model queries behind the Skills Lab Stats tab. They live here, with the
 * review aggregate, because every table they touch — `agent_runs`,
 * `run_traces`, `reviews`, `findings` — is owned by this module. The skills
 * module composes them through `container.reviewRepo` rather than reaching
 * across into these tables itself.
 *
 * Both functions are keyed BY SKILL and take an optional `skillId`, so the
 * single-skill tab and the whole-list card footer share one implementation:
 * without the filter the list endpoint costs one round-trip instead of N.
 *
 * Raw SQL rather than the query builder: both need `COUNT(*) FILTER (WHERE …)`,
 * which Drizzle cannot express. Every value is parameterised — there is no
 * injection surface.
 *
 * `since` is bound as an ISO string with an explicit `::timestamptz` cast: a
 * JS `Date` handed to a raw `sql` template fails to encode on the postgres-js
 * driver ("argument must be of type string… Received an instance of Date").
 */

/** Runs by agents linked to a skill, and how many actually injected its block. */
export interface SkillPullRow {
  skillId: string;
  total: number;
  pulled: number;
}

/**
 * How often a skill's block actually reached the model.
 *
 * The only durable record that a skill entered a prompt is the assembled text:
 * `formatSkillBlocks` (reviewer-core/src/prompt.ts) emits `### <name>`, so we
 * look for that heading inside `trace.prompt_assembly.skills`. `strpos` is a
 * LITERAL substring search — unlike `LIKE`, a name containing `%` or `_` needs
 * no escaping.
 *
 * Two consequences worth knowing before trusting the number:
 *  - Matching is by NAME, so renaming a skill orphans its history, and a name
 *    that is a prefix of another skill's name can over-match. Fixing that
 *    properly needs a run→skill link table written at review time.
 *  - The denominator is runs that PRODUCED A TRACE (inner join), not all runs.
 *    A run that failed before prompt assembly never had a chance to pull the
 *    skill, so counting it would understate the rate rather than measure it.
 */
export async function pullStatsBySkill(
  db: Db,
  workspaceId: string,
  since: Date,
  skillId?: string,
): Promise<SkillPullRow[]> {
  const rows = await db.execute<{ skill_id: string; total: number; pulled: number }>(sql`
    SELECT s.id AS skill_id,
           COUNT(*)::int AS total,
           COUNT(*) FILTER (
             WHERE strpos(rt.trace->'prompt_assembly'->>'skills', '### ' || s.name) > 0
           )::int AS pulled
    FROM skills s
    JOIN agent_skills asl ON asl.skill_id = s.id
    JOIN agent_runs ar    ON ar.agent_id = asl.agent_id
    JOIN run_traces rt    ON rt.run_id = ar.id
    WHERE s.workspace_id = ${workspaceId}
      AND ar.workspace_id = ${workspaceId}
      AND ar.ran_at >= ${since.toISOString()}::timestamptz
      ${skillId ? sql`AND s.id = ${skillId}` : sql``}
    GROUP BY s.id
  `);
  return [...rows].map((r) => ({
    skillId: r.skill_id,
    total: Number(r.total),
    pulled: Number(r.pulled),
  }));
}

/** One category's finding tally for a skill, within the window. */
export interface SkillFindingRow {
  skillId: string;
  category: string;
  total: number;
  accepted: number;
  dismissed: number;
}

/**
 * Findings produced by agents that link the skill, grouped by category.
 *
 * This is an ASSOCIATION, not attribution. No column records which skill
 * provoked a finding — `findings` hangs off `reviews`, and a review knows only
 * its agent. Callers must present the result as "findings from agents using
 * this skill"; calling it the skill's own hit rate would overstate what the
 * data supports.
 *
 * Accepted and dismissed are counted separately rather than as a ratio here,
 * so the caller can tell "nothing triaged yet" (both zero → rate is null) from
 * "everything was rejected" (accepted zero, dismissed non-zero → rate is 0).
 */
export async function findingStatsBySkill(
  db: Db,
  workspaceId: string,
  since: Date,
  skillId?: string,
): Promise<SkillFindingRow[]> {
  const rows = await db.execute<{
    skill_id: string;
    category: string;
    total: number;
    accepted: number;
    dismissed: number;
  }>(sql`
    SELECT s.id AS skill_id,
           f.category AS category,
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE f.accepted_at IS NOT NULL)::int AS accepted,
           COUNT(*) FILTER (WHERE f.dismissed_at IS NOT NULL)::int AS dismissed
    FROM skills s
    JOIN agent_skills asl ON asl.skill_id = s.id
    JOIN reviews r        ON r.agent_id = asl.agent_id
    JOIN findings f       ON f.review_id = r.id
    WHERE s.workspace_id = ${workspaceId}
      AND r.workspace_id = ${workspaceId}
      AND r.created_at >= ${since.toISOString()}::timestamptz
      ${skillId ? sql`AND s.id = ${skillId}` : sql``}
    GROUP BY s.id, f.category
  `);
  return [...rows].map((r) => ({
    skillId: r.skill_id,
    category: r.category,
    total: Number(r.total),
    accepted: Number(r.accepted),
    dismissed: Number(r.dismissed),
  }));
}
