import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ContextAttachmentInput } from '@devdigest/shared';
import { getContext } from '../_shared/context.js';
import { IdParams } from '../_shared/schemas.js';
import { ContextService } from './service.js';

/**
 * Project-context module (SPEC-01).
 *
 *   GET /repos/:id/context           → live discovery walk over the clone
 *   GET /repos/:id/context/file?path → one document's body (read-only preview)
 *   GET /agents/:id/context          → the agent's ordered attachments
 *   PUT /agents/:id/context          → replace them wholesale
 *   GET /skills/:id/context          → the skill's ordered attachments
 *   PUT /skills/:id/context          → replace them wholesale
 *
 * There is deliberately NO `/context/reindex`: discovery is a live walk with no
 * index behind it, so there is nothing to rebuild. (The dead `IndexStatus`
 * contract and the client hook that posted to such a route predate this module
 * and were removed with it.)
 *
 * PUT rather than POST because the body is the COMPLETE new set — array
 * position is the assembly order, so add, remove and reorder are all the same
 * idempotent replacement.
 */

const FileQuery = z.object({ path: z.string().min(1) });

export default async function contextRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const service = new ContextService(app.container);

  app.get('/repos/:id/context', { schema: { params: IdParams } }, async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    return service.listDocuments(workspaceId, req.params.id);
  });

  app.get(
    '/repos/:id/context/file',
    { schema: { params: IdParams, querystring: FileQuery } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      return service.readDocument(workspaceId, req.params.id, req.query.path);
    },
  );

  app.get('/agents/:id/context', { schema: { params: IdParams } }, async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    return { paths: await service.getAttachments(workspaceId, 'agent', req.params.id) };
  });

  app.put(
    '/agents/:id/context',
    { schema: { params: IdParams, body: ContextAttachmentInput } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      return {
        paths: await service.setAttachments(workspaceId, 'agent', req.params.id, req.body.paths),
      };
    },
  );

  app.get('/skills/:id/context', { schema: { params: IdParams } }, async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    return { paths: await service.getAttachments(workspaceId, 'skill', req.params.id) };
  });

  app.put(
    '/skills/:id/context',
    { schema: { params: IdParams, body: ContextAttachmentInput } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      return {
        paths: await service.setAttachments(workspaceId, 'skill', req.params.id, req.body.paths),
      };
    },
  );
}
