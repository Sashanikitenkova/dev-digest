import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getContext } from '../_shared/context.js';
import { DigestsService } from './service.js';
import { DigestsRepository } from './repository.js';
import { DEFAULT_PERIOD_DAYS } from './constants.js';

const GenerateBody = z.object({
  periodDays: z.number().int().min(1).max(90).default(DEFAULT_PERIOD_DAYS),
  regenerate: z.boolean().default(false),
});

const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).default(10) });

/**
 * Digests module.
 *   POST /digests        → build a digest of the PRs merged in the last N days
 *   GET  /digests        → the digests already built for this workspace
 *
 * A digest is a short markdown summary a team reads on Monday morning. Building
 * one costs a model call over every merged PR in the window, so a digest for a
 * period that was already built is reused unless the caller asks for a rebuild.
 */
export default async function digestsRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const service = new DigestsService(app.container);
  const repo = new DigestsRepository(app.container.db);

  app.post('/digests', { schema: { body: GenerateBody } }, async (req) => {
    const { workspaceId } = await getContext(app.container, req);

    const periodEnd = new Date();
    const periodStart = new Date(periodEnd.getTime() - req.body.periodDays * 24 * 60 * 60 * 1000);

    const existing = await repo.findByPeriod(workspaceId, periodStart, periodEnd);

    if (existing && !req.body.regenerate) {
      return { digest: existing, cached: true };
    }

    if (existing) {
      await repo.deleteById(workspaceId, existing.id);
    }

    const digest = await service.build(workspaceId, periodStart, periodEnd);
    return { digest, cached: false };
  });

  app.get('/digests', { schema: { querystring: ListQuery } }, async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    return { digests: await repo.listRecent(workspaceId, req.query.limit) };
  });
}
