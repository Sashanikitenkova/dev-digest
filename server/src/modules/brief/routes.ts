import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { PrRiskBriefRecord } from '@devdigest/shared';
import { getContext } from '../_shared/context.js';
import { IdParams } from '../_shared/schemas.js';
import { BriefService } from './service.js';

/**
 * Why + Risk brief module.
 *   GET  /pulls/:id/brief             → the stored brief, or null (never generated)
 *   POST /pulls/:id/brief             → generate, unless the stored brief is
 *                                       already for the current head
 *   POST /pulls/:id/brief/regenerate  → generate irrespective of the stored one
 *
 * THE SERVICE IS CONSTRUCTED ONCE, HERE, at plugin registration. It carries the
 * in-flight map that coalesces concurrent generations for the same pull request
 * and head SHA into one model call, and that map's lifetime IS this instance's.
 * Constructing the service inside a handler would give every request its own
 * empty map and silently delete the coalescing — no type error, no failing
 * typecheck, just a paid call per concurrent click.
 *
 * GET returns `null` rather than 404 for a PR with no brief yet, so the card
 * can render an empty state with a "Generate" button instead of an error — the
 * intent module's rule, for the same reason.
 *
 * The generate/regenerate split exists rather than one route with an optional
 * `{ force }` body because declaring even an optional Zod body makes a
 * body-less POST trip Fastify's "Body cannot be empty" check and 422. Both
 * POSTs therefore declare NO body schema at all.
 */

export default async function briefRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const service = new BriefService(app.container);

  app.get(
    '/pulls/:id/brief',
    // Read-only: one primary-key read, so no rate limit (the blast precedent).
    { schema: { params: IdParams } },
    async (req): Promise<PrRiskBriefRecord | null> => {
      const { workspaceId } = await getContext(app.container, req);
      return service.get(workspaceId, req.params.id);
    },
  );

  app.post(
    '/pulls/:id/brief',
    {
      schema: { params: IdParams },
      // One frontier-model call per miss — the same tight per-route budget the
      // other generation routes carry.
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req): Promise<PrRiskBriefRecord> => {
      const { workspaceId } = await getContext(app.container, req);
      return service.generate(workspaceId, req.params.id, {
        log: (obj, msg) => req.log.info(obj, msg),
        logError: (obj, msg) => req.log.error(obj, msg),
      });
    },
  );

  app.post(
    '/pulls/:id/brief/regenerate',
    {
      schema: { params: IdParams },
      // Carried on BOTH generation routes: a limit on one of them is not a
      // limit on the feature.
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req): Promise<PrRiskBriefRecord> => {
      const { workspaceId } = await getContext(app.container, req);
      return service.generate(workspaceId, req.params.id, {
        force: true,
        log: (obj, msg) => req.log.info(obj, msg),
        logError: (obj, msg) => req.log.error(obj, msg),
      });
    },
  );
}
