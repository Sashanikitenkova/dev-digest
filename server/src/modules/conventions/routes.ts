import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ConventionStatus } from '@devdigest/shared';
import { getContext } from '../_shared/context.js';
import { IdParams } from '../_shared/schemas.js';
import { NotFoundError } from '../../platform/errors.js';
import { ConventionsService } from './service.js';

/**
 * Conventions module.
 *   GET   /repos/:id/conventions          → triage list for a repo (newest first)
 *   POST  /repos/:id/conventions/extract  → sample → cheap model → GROUND → persist
 *   PATCH /conventions/:id                → accept / reject one candidate
 *
 * Extraction is synchronous: it is one cheap-model call over a bounded sample,
 * and the client shows a spinner on the button. It is not a JobRunner job
 * because the user is waiting on the result to triage it.
 */

const StatusBody = z.object({ status: ConventionStatus });

export default async function conventionsRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const service = new ConventionsService(app.container);

  app.get('/repos/:id/conventions', { schema: { params: IdParams } }, async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    return service.list(workspaceId, req.params.id);
  });

  app.post('/repos/:id/conventions/extract', { schema: { params: IdParams } }, async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    return service.extract(workspaceId, req.params.id, (obj, msg) => req.log.info(obj, msg));
  });

  app.patch(
    '/conventions/:id',
    { schema: { params: IdParams, body: StatusBody } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      const updated = await service.setStatus(workspaceId, req.params.id, req.body.status);
      if (!updated) throw new NotFoundError('Convention not found');
      return updated;
    },
  );
}
