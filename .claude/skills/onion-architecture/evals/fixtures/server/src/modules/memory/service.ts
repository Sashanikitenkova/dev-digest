import type { Container } from '../../platform/container.js';
import { NotFoundError } from '../../platform/errors.js';
import { MemoryRepository, type MemoryRow } from './repository.js';
import { dedupeByContent } from './helpers.js';
import { DEFAULT_SEARCH_LIMIT } from './constants.js';

export interface RememberInput {
  scope: 'repo' | 'global' | 'team';
  kind: 'decision' | 'convention' | 'preference' | 'fact' | 'learning';
  content: string;
  repoId?: string;
}

export interface SearchOptions {
  repoId?: string;
  limit?: number;
}

/**
 * Memory orchestration.
 *
 * Embedding is best-effort: a workspace without an embedding key still stores
 * the item (with a null embedding) so nothing is lost, and search degrades to
 * returning nothing rather than throwing — the panel that renders it is one of
 * several on the page and must not take the others down with it.
 */
export class MemoryService {
  private repo: MemoryRepository;

  constructor(private container: Container) {
    this.repo = new MemoryRepository(container.db);
  }

  async remember(workspaceId: string, input: RememberInput): Promise<MemoryRow> {
    const embedding = await this.embedOrNull(input.content);
    return this.repo.insertItem({ workspaceId, ...input, embedding });
  }

  async search(workspaceId: string, query: string, opts: SearchOptions = {}): Promise<MemoryRow[]> {
    const embedding = await this.embedOrNull(query);
    if (!embedding) return [];

    const rows = await this.repo.nearest(workspaceId, embedding, {
      repoId: opts.repoId,
      limit: opts.limit ?? DEFAULT_SEARCH_LIMIT,
    });

    await this.repo.markUsed(rows.map((r) => r.id));
    return dedupeByContent(rows);
  }

  async forget(workspaceId: string, id: string): Promise<void> {
    const deleted = await this.repo.deleteItem(workspaceId, id);
    if (!deleted) throw new NotFoundError('Memory item not found');
  }

  private async embedOrNull(text: string): Promise<number[] | null> {
    try {
      const embedder = await this.container.embedder();
      const [vector] = await embedder.embed([text]);
      return vector ?? null;
    } catch {
      return null;
    }
  }
}
