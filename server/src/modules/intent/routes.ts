import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { PrIntentRecord } from '@devdigest/shared';
import { getContext } from '../_shared/context.js';
import { IdParams } from '../_shared/schemas.js';
import { IntentService } from './service.js';

/**
 * Intent module.
 *   GET  /pulls/:id/intent         → the stored intent, or null (never detected)
 *   POST /pulls/:id/intent/detect  → assemble sources → cheap model → persist
 *
 * Detection is synchronous rather than a JobRunner job, for the same reason the
 * conventions extractor is: it is ONE bounded cheap-model call and the user is
 * waiting on the result. A review run reaches the same code through
 * `IntentService.ensureFresh`, not through these routes.
 *
 * GET returns `null` rather than 404 for a PR with no intent yet, so the UI can
 * render an empty state with a "Detect" button instead of an error.
 */

export default async function intentRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const service = new IntentService(app.container);

  app.get(
    '/pulls/:id/intent',
    { schema: { params: IdParams } },
    async (req): Promise<PrIntentRecord | null> => {
      const { workspaceId } = await getContext(app.container, req);
      return service.get(workspaceId, req.params.id);
    },
  );

  app.post(
    '/pulls/:id/intent/detect',
    {
      // No body schema: detection takes no arguments (it always re-runs against
      // the current head), and declaring even an optional body would make a
      // body-less POST trip Fastify's "Body cannot be empty" check.
      schema: { params: IdParams },
      // One LLM call per hit — the same tight budget the review trigger uses.
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req): Promise<PrIntentRecord> => {
      const { workspaceId } = await getContext(app.container, req);
      return service.detect(workspaceId, req.params.id, {
        log: (obj, msg) => req.log.info(obj, msg),
      });
    },
  );
}
