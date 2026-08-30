import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { getContext } from '../_shared/context.js';
import { IdParams } from '../_shared/schemas.js';
import { BlastService, type PrBlast } from './service.js';

/**
 * Blast module.
 *   GET /pulls/:id/blast → changed symbols, their callers, impacted
 *                          endpoints/crons, and prior PRs touching the same files
 *
 * Read-only and deterministic (index lookups + one SQL join), so there is no
 * rate limit and no job: it is safe to call on every Overview render.
 */

export default async function blastRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const service = new BlastService(app.container);

  app.get('/pulls/:id/blast', { schema: { params: IdParams } }, async (req): Promise<PrBlast> => {
    const { workspaceId } = await getContext(app.container, req);
    return service.getForPull(workspaceId, req.params.id, (obj, msg) => req.log.debug(obj, msg));
  });
}
