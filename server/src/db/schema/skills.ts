import { pgTable, uuid, text, integer, boolean, jsonb, primaryKey } from 'drizzle-orm/pg-core';
import { now } from './_shared';
import { workspaces } from './core';

export const skills = pgTable('skills', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description').notNull(),
  type: text('type', { enum: ['rubric', 'convention', 'security', 'custom'] }).notNull(),
  source: text('source', {
    enum: ['manual', 'imported_url', 'extracted', 'community'],
  }).notNull(),
  body: text('body').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  version: integer('version').notNull().default(1),
  evidenceFiles: jsonb('evidence_files').$type<string[]>(),
  createdAt: now(),
});

export const skillVersions = pgTable(
  'skill_versions',
  {
    skillId: uuid('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    body: text('body').notNull(),
    createdAt: now(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.skillId, t.version] }) }),
);

/**
 * Project-context documents attached to a SKILL (SPEC-01). Any agent linking
 * the skill inherits them, which is what makes a document travel with the rule
 * that references it.
 *
 * Structurally identical to `agentContextFiles`; the two are separate tables so
 * each can carry its own FK cascade. It lives in this file rather than in
 * `db/schema/context.ts` because that module imports only `workspaces`/`repos`
 * and referencing `skills` from it would create an import cycle.
 */
export const skillContextFiles = pgTable(
  'skill_context_files',
  {
    skillId: uuid('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    order: integer('order').notNull().default(0),
  },
  (t) => ({ pk: primaryKey({ columns: [t.skillId, t.path] }) }),
);
