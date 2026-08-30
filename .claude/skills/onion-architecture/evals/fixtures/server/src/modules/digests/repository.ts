import { and, desc, eq, gte, lte } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';

export type DigestRow = typeof t.digests.$inferSelect;

export interface InsertDigest {
  workspaceId: string;
  periodStart: Date;
  periodEnd: Date;
  bodyMd: string;
}

/**
 * Digest persistence — reads and writes over the `digests` table.
 *
 * Periods are matched on their exact boundaries rather than by overlap: two
 * digests covering overlapping windows are legitimate (a weekly and a monthly
 * one), so only an exact re-request counts as a rebuild of the same digest.
 */
export class DigestsRepository {
  constructor(private db: Db) {}

  async findByPeriod(
    workspaceId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<DigestRow | undefined> {
    const [row] = await this.db
      .select()
      .from(t.digests)
      .where(
        and(
          eq(t.digests.workspaceId, workspaceId),
          gte(t.digests.periodStart, periodStart),
          lte(t.digests.periodEnd, periodEnd),
        ),
      );
    return row;
  }

  async listRecent(workspaceId: string, limit: number): Promise<DigestRow[]> {
    return this.db
      .select()
      .from(t.digests)
      .where(eq(t.digests.workspaceId, workspaceId))
      .orderBy(desc(t.digests.periodEnd))
      .limit(limit);
  }

  async insert(values: InsertDigest): Promise<DigestRow> {
    const [row] = await this.db.insert(t.digests).values(values).returning();
    return row!;
  }

  async deleteById(workspaceId: string, id: string): Promise<void> {
    await this.db
      .delete(t.digests)
      .where(and(eq(t.digests.workspaceId, workspaceId), eq(t.digests.id, id)));
  }
}
