import { pgTable, uuid, text, integer, boolean, jsonb, primaryKey } from 'drizzle-orm/pg-core';
import { now } from './_shared';
import { workspaces, users } from './core';
import { skills } from './skills';

// ============================================================ Agents & skills

export const agents = pgTable('agents', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  provider: text('provider', { enum: ['openai', 'anthropic', 'openrouter'] }).notNull(),
  model: text('model').notNull(),
  systemPrompt: text('system_prompt').notNull(),
  outputSchema: jsonb('output_schema'),
  // Review execution strategy — whole diff in one call (default) vs per-file.
  strategy: text('strategy', { enum: ['single-pass', 'map-reduce', 'auto'] })
    .notNull()
    .default('single-pass'),
  // CI gate policy — when a CI review should BLOCK (REQUEST_CHANGES + fail the
  // check) vs just comment. Deterministic from finding severities.
  ciFailOn: text('ci_fail_on', { enum: ['never', 'critical', 'warning', 'any'] })
    .notNull()
    .default('critical'),
  // Whether this agent's reviews get repo-intel context (repo skeleton + callers
  // + file-rank note) injected into the prompt. Default on; the global
  // REPO_INTEL_ENABLED flag is the second gate (facade degrades when off).
  repoIntel: boolean('repo_intel').notNull().default(true),
  enabled: boolean('enabled').notNull().default(true),
  version: integer('version').notNull().default(1),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: now(),
});

export const agentVersions = pgTable(
  'agent_versions',
  {
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    configJson: jsonb('config_json').notNull(),
    createdAt: now(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.agentId, t.version] }) }),
);

export const agentSkills = pgTable(
  'agent_skills',
  {
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    skillId: uuid('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    order: integer('order').notNull().default(0),
    // Per-link switch: does this link contribute a prompt block? A linked-but-
    // disabled skill keeps its `order`, so re-enabling restores its position.
    enabled: boolean('enabled').notNull().default(true),
  },
  (t) => ({ pk: primaryKey({ columns: [t.agentId, t.skillId] }) }),
);

/**
 * Project-context documents attached DIRECTLY to an agent (SPEC-01).
 *
 * Mirrors `agentSkills` deliberately: a real link table with an FK and
 * `ON DELETE CASCADE`, not a jsonb column on `agents`. Two reasons —
 *   • a jsonb column would be part of the agent config `isConfigChange`
 *     inspects, so attaching a document would bump `agents.version` and write a
 *     version-history row, which AC-11 forbids: attaching context is not a
 *     change to the agent's prompt;
 *   • one discriminated table shared with skills could not carry an FK to two
 *     different parents, so deleting an agent would leave orphan rows.
 *
 * `path` is the repo-relative path and doubles as the identity — the file on
 * disk is the record, so there is no id. It is intentionally NOT scoped to a
 * repo: an attachment is "this document, by path, in whichever repo is being
 * reviewed", which is what makes one agent reusable across repos that share a
 * convention. `order` is the assembly order, replaced wholesale on every PUT.
 */
export const agentContextFiles = pgTable(
  'agent_context_files',
  {
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    order: integer('order').notNull().default(0),
  },
  (t) => ({ pk: primaryKey({ columns: [t.agentId, t.path] }) }),
);
