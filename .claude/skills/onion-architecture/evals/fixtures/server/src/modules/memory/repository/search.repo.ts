import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { Db } from '../../../db/client.js';
import * as t from '../../../db/schema.js';
import type { MemoryRow, NearestOptions } from '../repository.js';

/** Vector search for the memory domain — composed by `MemoryRepository`. */

export async function nearest(
  db: Db,
  workspaceId: string,
  embedding: number[],
  opts: NearestOptions,
): Promise<MemoryRow[]> {
  const distance = sql`${t.memory.embedding} <=> ${JSON.stringify(embedding)}::vector`;

  return db
    .select()
    .from(t.memory)
    .where(
      and(
        eq(t.memory.workspaceId, workspaceId),
        isNotNull(t.memory.embedding),
        opts.repoId ? eq(t.memory.repoId, opts.repoId) : undefined,
      ),
    )
    .orderBy(distance)
    .limit(opts.limit);
}
