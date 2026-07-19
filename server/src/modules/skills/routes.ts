import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { SkillSource, SkillType } from '@devdigest/shared';
import { getContext } from '../_shared/context.js';
import { IdParams } from '../_shared/schemas.js';
import { NotFoundError } from '../../platform/errors.js';
import { SkillsService } from './service.js';
import { IMPORT_BODY_LIMIT_BYTES } from './constants.js';

/**
 * Skills module.
 *   GET    /skills                        → list (workspace-scoped)
 *   GET    /skills/:id                    → one skill
 *   POST   /skills                        → create (writes version 1)
 *   PUT    /skills/:id                    → update; body change → new version
 *   DELETE /skills/:id                    → delete; agent links cascade
 *   GET    /skills/:id/versions           → body history (newest first)
 *   GET    /skills/:id/versions/:version  → one body snapshot (Diff/Restore)
 *   POST   /skills/import/preview         → parse a .md/.zip; PERSISTS NOTHING
 */

/** `/skills/:id/versions/:version` — id is a uuid, version a positive integer. */
const VersionParams = z.object({
  id: z.string().uuid(),
  version: z.coerce.number().int().positive(),
});

const CreateSkillBody = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  type: SkillType.optional(),
  // `source` is accepted so the import drawer can save what it previewed; the
  // service still forces a non-manual skill to arrive disabled.
  source: SkillSource.optional(),
  body: z.string().min(1),
  enabled: z.boolean().optional(),
  evidence_files: z.array(z.string()).nullish(),
});

const UpdateSkillBody = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  type: SkillType.optional(),
  body: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  evidence_files: z.array(z.string()).nullish(),
});

/**
 * Import posts the file as base64 inside a normal JSON body rather than
 * multipart: it keeps the Zod route-validation convention intact and needs no
 * new server dependency.
 */
const ImportPreviewBody = z.object({
  filename: z.string().min(1),
  content_base64: z.string().min(1),
});

export default async function skillsRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const service = new SkillsService(app.container);

  app.get('/skills', async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    return service.list(workspaceId);
  });

  // `bodyLimit` is per-route: the app-wide limit is 1 MB (app.ts), which a
  // base64-encoded archive blows through immediately. Raised here ONLY.
  app.post(
    '/skills/import/preview',
    { bodyLimit: IMPORT_BODY_LIMIT_BYTES, schema: { body: ImportPreviewBody } },
    async (req) => {
      await getContext(app.container, req);
      return service.importPreview(req.body.filename, req.body.content_base64);
    },
  );

  app.get('/skills/:id', { schema: { params: IdParams } }, async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    const skill = await service.get(workspaceId, req.params.id);
    if (!skill) throw new NotFoundError('Skill not found');
    return skill;
  });

  app.post('/skills', { schema: { body: CreateSkillBody } }, async (req, reply) => {
    const { workspaceId } = await getContext(app.container, req);
    const body = req.body;
    const skill = await service.create(workspaceId, {
      name: body.name,
      body: body.body,
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.type !== undefined ? { type: body.type } : {}),
      ...(body.source !== undefined ? { source: body.source } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.evidence_files !== undefined ? { evidence_files: body.evidence_files } : {}),
    });
    reply.status(201);
    return skill;
  });

  app.put('/skills/:id', { schema: { params: IdParams, body: UpdateSkillBody } }, async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    const body = req.body;
    const skill = await service.update(workspaceId, req.params.id, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.type !== undefined ? { type: body.type } : {}),
      ...(body.body !== undefined ? { body: body.body } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.evidence_files !== undefined ? { evidence_files: body.evidence_files } : {}),
    });
    if (!skill) throw new NotFoundError('Skill not found');
    return skill;
  });

  app.delete('/skills/:id', { schema: { params: IdParams } }, async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    const ok = await service.delete(workspaceId, req.params.id);
    if (!ok) throw new NotFoundError('Skill not found');
    return { ok: true };
  });

  app.get('/skills/:id/versions', { schema: { params: IdParams } }, async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    const versions = await service.listVersions(workspaceId, req.params.id);
    if (!versions) throw new NotFoundError('Skill not found');
    return versions;
  });

  app.get('/skills/:id/versions/:version', { schema: { params: VersionParams } }, async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    const version = await service.getVersion(workspaceId, req.params.id, req.params.version);
    if (!version) throw new NotFoundError('Skill version not found');
    return version;
  });
}
