import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getContext } from '../_shared/context.js';
import { IdParams } from '../_shared/schemas.js';
import { MemoryService } from './service.js';
import { DEFAULT_SEARCH_LIMIT } from './constants.js';

const RememberBody = z.object({
  scope: z.enum(['repo', 'global', 'team']),
  kind: z.enum(['decision', 'convention', 'preference', 'fact', 'learning']),
  content: z.string().min(1).max(2000),
  repoId: z.string().uuid().optional(),
});

const SearchQuery = z.object({
  q: z.string().min(1),
  repoId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(DEFAULT_SEARCH_LIMIT),
});

/**
 * Memory module.
 *   POST   /memory        → remember one item
 *   GET    /memory/search → nearest items for a query
 *   DELETE /memory/:id    → forget one item
 *
 * Items are embedded on write so search is a single vector query at read time;
 * a workspace with no embedder configured still accepts writes and simply
 * returns nothing from search, which keeps the panel usable offline.
 */
export default async function memoryRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const service = new MemoryService(app.container);

  app.post('/memory', { schema: { body: RememberBody } }, async (req, reply) => {
    const { workspaceId } = await getContext(app.container, req);
    const item = await service.remember(workspaceId, req.body);
    reply.status(201);
    return item;
  });

  app.get('/memory/search', { schema: { querystring: SearchQuery } }, async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    const { q, repoId, limit } = req.query;
    return { items: await service.search(workspaceId, q, { repoId, limit }) };
  });

  app.delete('/memory/:id', { schema: { params: IdParams } }, async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    await service.forget(workspaceId, req.params.id);
    return { ok: true };
  });
}
