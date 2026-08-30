import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../../db/client.js';
import * as t from '../../../db/schema.js';
import type { InsertMemory, MemoryRow } from '../repository.js';

/** Item writes for the memory domain — composed by `MemoryRepository`. */

export async function insertItem(db: Db, values: InsertMemory): Promise<MemoryRow> {
  const [row] = await db.insert(t.memory).values(values).returning();
  return row!;
}

export async function deleteItem(db: Db, workspaceId: string, id: string): Promise<boolean> {
  const [row] = await db
    .delete(t.memory)
    .where(and(eq(t.memory.workspaceId, workspaceId), eq(t.memory.id, id)))
    .returning({ id: t.memory.id });
  return !!row;
}

/** Recency feeds ranking later; a failed touch must never fail the read. */
export async function markUsed(db: Db, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.update(t.memory).set({ lastUsedAt: new Date() }).where(inArray(t.memory.id, ids));
}
