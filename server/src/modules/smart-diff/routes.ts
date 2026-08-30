import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { SmartDiff } from '@devdigest/shared';
import { getContext } from '../_shared/context.js';
import { IdParams } from '../_shared/schemas.js';
import { SmartDiffService } from './service.js';

/**
 * Smart-diff module.
 *   GET /pulls/:id/smart-diff → changed files grouped into core / wiring /
 *                               boilerplate, with the latest round's finding
 *                               lines attached per file
 *
 * Read-only and deterministic (one classifier pass over rows already in the
 * DB), so — like `blast` — there is no rate limit and no persistence: it is
 * recomputed per request rather than cached and left to go stale.
 */

export default async function smartDiffRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const service = new SmartDiffService(app.container);

  app.get('/pulls/:id/smart-diff', { schema: { params: IdParams } }, async (req): Promise<SmartDiff> => {
    const { workspaceId } = await getContext(app.container, req);
    return service.getForPull(workspaceId, req.params.id);
  });
}
