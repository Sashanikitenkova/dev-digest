import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';

/**
 * Memory persistence — reads and writes over the `memory` table.
 *
 * The query implementations are colocated, split by aggregate, under
 * `./repository/` (item writes vs. vector search — they share a table but not a
 * reason to change: one follows the schema, the other follows how pgvector is
 * tuned). This class composes them so its public API stays identical.
 */

import * as itemRepo from './repository/item.repo.js';
import * as searchRepo from './repository/search.repo.js';

export type MemoryRow = typeof t.memory.$inferSelect;

export interface InsertMemory {
  workspaceId: string;
  repoId?: string;
  scope: 'repo' | 'global' | 'team';
  kind: 'decision' | 'convention' | 'preference' | 'fact' | 'learning';
  content: string;
  embedding: number[] | null;
}

export interface NearestOptions {
  repoId?: string;
  limit: number;
}

export class MemoryRepository {
  constructor(private db: Db) {}

  insertItem(values: InsertMemory): Promise<MemoryRow> {
    return itemRepo.insertItem(this.db, values);
  }

  deleteItem(workspaceId: string, id: string): Promise<boolean> {
    return itemRepo.deleteItem(this.db, workspaceId, id);
  }

  markUsed(ids: string[]): Promise<void> {
    return itemRepo.markUsed(this.db, ids);
  }

  nearest(workspaceId: string, embedding: number[], opts: NearestOptions): Promise<MemoryRow[]> {
    return searchRepo.nearest(this.db, workspaceId, embedding, opts);
  }
}
