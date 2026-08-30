import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { EvalOwnerKind } from '@devdigest/shared';
import { getContext } from '../_shared/context.js';
import { IdParams } from '../_shared/schemas.js';
import { EvalService } from './service.js';

/**
 * Eval pipeline module (SPEC-03).
 *   POST   /findings/:id/eval-case   → freeze a reviewed finding into a case
 *   GET    /eval/cases               → the owner's case set (+ last results)
 *   POST   /eval/cases               → create a case by hand
 *   PUT    /eval/cases/:id           → edit a case
 *   DELETE /eval/cases/:id           → delete a case
 *   POST   /agents/:id/eval-runs     → start a batch over the whole set (202)
 *   GET    /eval/runs/:id            → batch + per-case rows (polled while running)
 *   GET    /eval/runs                → batch history for the trend + compare table
 *   GET    /eval/dashboard           → per-agent aggregate
 *   GET    /eval/overview            → workspace-wide agent cards + recent runs
 *   GET    /eval/compare             → two batches side by side
 *   GET    /eval/case-findings       → which findings already have a case
 */

const OwnerQuery = z.object({
  owner_kind: EvalOwnerKind.default('agent'),
  owner_id: z.string().uuid(),
});

const ExpectationBody = z.object({
  kind: z.enum(['must_find', 'must_not_flag']),
  targets: z
    .array(
      z.object({
        file: z.string().min(1),
        start_line: z.number().int(),
        end_line: z.number().int(),
        severity: z.string().nullish(),
        category: z.string().nullish(),
        title: z.string().nullish(),
      }),
    )
    .min(1),
});

const CreateCaseBody = z.object({
  owner_kind: EvalOwnerKind.default('agent'),
  owner_id: z.string().uuid(),
  name: z.string().min(1),
  input_diff: z.string().min(1),
  expected_output: ExpectationBody,
  notes: z.string().nullish(),
});

const UpdateCaseBody = z.object({
  name: z.string().min(1).optional(),
  input_diff: z.string().min(1).optional(),
  expected_output: ExpectationBody.optional(),
  notes: z.string().nullish().optional(),
});

const RunsQuery = z.object({
  owner_id: z.string().uuid().optional(),
  owner_kind: EvalOwnerKind.default('agent'),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

const CompareQuery = z.object({ a: z.string().uuid(), b: z.string().uuid() });

const FindingIdsQuery = z.object({
  /** Comma-separated finding ids — the panel asks about a whole review at once. */
  ids: z.string().min(1),
});

export default async function evalRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const service = new EvalService(app.container);

  // ---- cases --------------------------------------------------------------

  app.post('/findings/:id/eval-case', { schema: { params: IdParams } }, async (req, reply) => {
    const { workspaceId } = await getContext(app.container, req);
    const created = await service.createFromFinding(workspaceId, req.params.id);
    return reply.code(201).send(created);
  });

  app.get('/eval/cases', { schema: { querystring: OwnerQuery } }, async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    const owner = {
      workspaceId,
      ownerKind: req.query.owner_kind,
      ownerId: req.query.owner_id,
    };
    const [cases, latest] = await Promise.all([
      service.listCases(owner),
      service.latestResults(owner),
    ]);
    return { cases, latest };
  });

  app.get('/eval/case-findings', { schema: { querystring: FindingIdsQuery } }, async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    const ids = req.query.ids.split(',').filter(Boolean);
    return { finding_ids: await service.findingIdsWithCases(workspaceId, ids) };
  });

  app.post('/eval/cases', { schema: { body: CreateCaseBody } }, async (req, reply) => {
    const { workspaceId } = await getContext(app.container, req);
    const created = await service.createCase(workspaceId, req.body);
    return reply.code(201).send(created);
  });

  app.put(
    '/eval/cases/:id',
    { schema: { params: IdParams, body: UpdateCaseBody } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      return service.updateCase(workspaceId, req.params.id, req.body);
    },
  );

  app.delete('/eval/cases/:id', { schema: { params: IdParams } }, async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    await service.deleteCase(workspaceId, req.params.id);
    return { ok: true };
  });

  // ---- runs ---------------------------------------------------------------

  // No `body` schema on purpose: a body-less POST 422s against a
  // `z.object({}).optional()` schema (server/INSIGHTS.md, 2026-08-11).
  app.post('/agents/:id/eval-runs', { schema: { params: IdParams } }, async (req, reply) => {
    const { workspaceId } = await getContext(app.container, req);
    const started = await service.startAgentBatch(workspaceId, req.params.id, {
      info: (obj, msg) => req.log.info(obj, msg),
      warn: (obj, msg) => req.log.warn(obj, msg),
      error: (obj, msg) => req.log.error(obj, msg),
    });
    // 202: the batch is queued, not finished — the client polls GET /eval/runs/:id.
    return reply.code(202).send(started);
  });

  app.get('/eval/runs/:id', { schema: { params: IdParams } }, async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    return service.getBatchDetail(workspaceId, req.params.id);
  });

  app.get('/eval/runs', { schema: { querystring: RunsQuery } }, async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    const owner = req.query.owner_id
      ? { ownerKind: req.query.owner_kind, ownerId: req.query.owner_id }
      : undefined;
    return service.listBatches(workspaceId, owner, req.query.limit);
  });

  // ---- dashboard + compare ------------------------------------------------

  app.get('/eval/dashboard', { schema: { querystring: OwnerQuery } }, async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    return service.dashboard(workspaceId, req.query.owner_id);
  });

  app.get('/eval/overview', async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    return service.overview(workspaceId);
  });

  app.get('/eval/compare', { schema: { querystring: CompareQuery } }, async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    return service.compare(workspaceId, req.query.a, req.query.b);
  });
}
