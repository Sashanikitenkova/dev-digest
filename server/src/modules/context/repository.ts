import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';

/**
 * Project-context data access (SPEC-01). Owns `agent_context_files` and
 * `skill_context_files`, and nothing else — every Drizzle call for this domain
 * lives in this file.
 *
 * It also reads the `repos` row it needs (clone path + coordinates) directly,
 * following the conventions module's precedent: a module never reaches into
 * another module's folder, and `repos` is a plain table read here rather than
 * repos-module business logic.
 */

export type RepoRow = typeof t.repos.$inferSelect;

/**
 * Which side of the attachment a call is about. The two tables are structurally
 * identical but separate (each needs its own FK cascade), so one generic
 * implementation keyed on this discriminator beats two copy-pasted classes that
 * can drift.
 */
export type ContextOwnerKind = 'agent' | 'skill';

export class ContextRepository {
  constructor(private db: Db) {}

  async getRepo(workspaceId: string, repoId: string): Promise<RepoRow | undefined> {
    const [row] = await this.db
      .select()
      .from(t.repos)
      .where(and(eq(t.repos.workspaceId, workspaceId), eq(t.repos.id, repoId)));
    return row;
  }

  /** Attached paths for one owner, in `order` ascending — assembly order. */
  async list(kind: ContextOwnerKind, ownerId: string): Promise<string[]> {
    if (kind === 'agent') {
      const rows = await this.db
        .select({ path: t.agentContextFiles.path })
        .from(t.agentContextFiles)
        .where(eq(t.agentContextFiles.agentId, ownerId))
        .orderBy(asc(t.agentContextFiles.order));
      return rows.map((r) => r.path);
    }
    const rows = await this.db
      .select({ path: t.skillContextFiles.path })
      .from(t.skillContextFiles)
      .where(eq(t.skillContextFiles.skillId, ownerId))
      .orderBy(asc(t.skillContextFiles.order));
    return rows.map((r) => r.path);
  }

  /**
   * Attached paths for SEVERAL skills in one round-trip, grouped by skill id.
   *
   * The review path resolves an agent's own attachments plus those of every
   * enabled linked skill; doing that with one query per skill would be an N+1
   * on the hot path of every review. Skills with no attachments are simply
   * absent from the map — callers default to `[]`.
   */
  async listForSkills(skillIds: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (skillIds.length === 0) return out;
    const rows = await this.db
      .select({ skillId: t.skillContextFiles.skillId, path: t.skillContextFiles.path })
      .from(t.skillContextFiles)
      .where(inArray(t.skillContextFiles.skillId, skillIds))
      .orderBy(asc(t.skillContextFiles.order));
    for (const r of rows) {
      const list = out.get(r.skillId) ?? [];
      list.push(r.path);
      out.set(r.skillId, list);
    }
    return out;
  }

  /**
   * Replace an owner's WHOLE ordered attachment set.
   *
   * Delete-then-insert inside ONE transaction, the pattern
   * `AgentsRepository.setSkills` established: array position is the order, so a
   * reorder and a removal are the same operation and there is no per-row
   * `order` to reconcile. The transaction is what stops a mid-swap failure from
   * leaving the owner with no attachments at all.
   *
   * Unlike `setSkills` there are no per-link flags to read and re-apply — an
   * attachment carries no state beyond its position, so nothing can be
   * resurrected by a reorder.
   *
   * THE OWNER ROW IS LOCKED FIRST, and that is load-bearing. The transaction
   * alone does not make delete-then-insert safe against a CONCURRENT replace of
   * the same owner: under READ COMMITTED, T2's DELETE evaluates against the
   * snapshot from before T1 committed, so it removes nothing, and T2's INSERT
   * then collides with the row T1 just wrote —
   * `duplicate key value violates unique constraint "..._pk"`, surfaced as a
   * 500. Two quick clicks in the editor are enough to produce it. `FOR UPDATE`
   * on the owner makes a second replace wait rather than interleave, so its
   * delete runs against post-commit state. The lock is per ROW, so writes to
   * different agents/skills still run in parallel.
   */
  async replace(kind: ContextOwnerKind, ownerId: string, paths: string[]): Promise<string[]> {
    await this.db.transaction(async (tx) => {
      if (kind === 'agent') {
        // Serializes concurrent replaces for THIS agent. The row is guaranteed
        // to exist — the service's `assertOwner` ran before we got here.
        await tx
          .select({ id: t.agents.id })
          .from(t.agents)
          .where(eq(t.agents.id, ownerId))
          .for('update');
        await tx.delete(t.agentContextFiles).where(eq(t.agentContextFiles.agentId, ownerId));
        if (paths.length > 0) {
          await tx
            .insert(t.agentContextFiles)
            .values(paths.map((path, order) => ({ agentId: ownerId, path, order })));
        }
        return;
      }
      await tx
        .select({ id: t.skills.id })
        .from(t.skills)
        .where(eq(t.skills.id, ownerId))
        .for('update');
      await tx.delete(t.skillContextFiles).where(eq(t.skillContextFiles.skillId, ownerId));
      if (paths.length > 0) {
        await tx
          .insert(t.skillContextFiles)
          .values(paths.map((path, order) => ({ skillId: ownerId, path, order })));
      }
    });
    return this.list(kind, ownerId);
  }

  /**
   * `path → number of agents in the workspace attaching it DIRECTLY`.
   *
   * Grouped in SQL rather than per document: the Project Context page renders
   * this count for every discovered file, and a per-path query would be a
   * textbook N+1. Skill-inherited attachments are deliberately excluded — the
   * number answers "how many agents chose this file", and folding in every
   * agent that happens to link a skill would make a popular skill's document
   * look universally adopted. Paths absent from the map have a count of 0.
   */
  async countAgentAttachmentsByPath(workspaceId: string): Promise<Map<string, number>> {
    const rows = await this.db
      .select({
        path: t.agentContextFiles.path,
        total: sql<number>`count(distinct ${t.agentContextFiles.agentId})`,
      })
      .from(t.agentContextFiles)
      .innerJoin(t.agents, eq(t.agentContextFiles.agentId, t.agents.id))
      .where(eq(t.agents.workspaceId, workspaceId))
      .groupBy(t.agentContextFiles.path);
    return new Map(rows.map((r) => [r.path, Number(r.total)]));
  }

  /** Does this agent exist in the workspace? Ownership gate for the PUT route. */
  async agentExists(workspaceId: string, agentId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: t.agents.id })
      .from(t.agents)
      .where(and(eq(t.agents.workspaceId, workspaceId), eq(t.agents.id, agentId)));
    return row != null;
  }

  /** Does this skill exist in the workspace? Ownership gate for the PUT route. */
  async skillExists(workspaceId: string, skillId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: t.skills.id })
      .from(t.skills)
      .where(and(eq(t.skills.workspaceId, workspaceId), eq(t.skills.id, skillId)));
    return row != null;
  }
}
