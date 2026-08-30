import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';
import type { ChangedFile } from './helpers.js';

/**
 * Risk data-access — `pr_files` only. The workspace-scoped PR guard is repeated
 * here rather than imported from another module's repository, per the house rule
 * that a module never reaches into another module's folder.
 */
export class RisksRepository {
  constructor(private db: Db) {}

  async prExists(workspaceId: string, prId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: t.pullRequests.id })
      .from(t.pullRequests)
      .where(and(eq(t.pullRequests.workspaceId, workspaceId), eq(t.pullRequests.id, prId)));
    return !!row;
  }

  /** Paths plus patches — the scan needs the patch text for dependency risks. */
  async changedFiles(prId: string): Promise<ChangedFile[]> {
    return this.db
      .select({ path: t.prFiles.path, patch: t.prFiles.patch })
      .from(t.prFiles)
      .where(eq(t.prFiles.prId, prId));
  }
}
