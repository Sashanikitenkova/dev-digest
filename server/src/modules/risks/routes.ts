import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Risks } from '@devdigest/shared';
import { getContext } from '../_shared/context.js';
import { IdParams } from '../_shared/schemas.js';
import { RisksService } from './service.js';

/**
 * Risks module.
 *   GET /pulls/:id/risks → deterministic risk areas derived from the diff
 *
 * Kept separate from `/pulls/:id/blast` even though both scan `pr_files`: they
 * answer different questions and the panels that render them fail independently.
 */

export default async function risksRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const service = new RisksService(app.container);

  app.get('/pulls/:id/risks', { schema: { params: IdParams } }, async (req): Promise<Risks> => {
    const { workspaceId } = await getContext(app.container, req);
    return service.getForPull(workspaceId, req.params.id);
  });
}
