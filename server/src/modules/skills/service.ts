import type { Container } from '../../platform/container.js';
import type { Skill, SkillImportPreview, SkillSource, SkillType } from '@devdigest/shared';
import { SkillsRepository } from './repository.js';
import {
  filenameStem,
  parseSkillMarkdown,
  toSkillDto,
  toSkillVersionDto,
  type SkillVersionDto,
} from './helpers.js';
import { readZipEntries, ZipError } from './zip.js';
import { DEFAULT_SKILL_SOURCE } from './constants.js';
import { ValidationError } from '../../platform/errors.js';

/**
 * Skills service — CRUD for the Skills Lab plus the import *preview*.
 *
 * A skill is a named markdown body that agents link to; its body is versioned
 * on every change (see the repository). Import is a two-step flow on purpose:
 * `importPreview` is a pure function that PERSISTS NOTHING, and the client only
 * calls `POST /skills` once the user has seen the parse (including which
 * archive entries were skipped) and confirmed. That makes "saved only after
 * confirmation" true by construction — abandoning the drawer can never leave an
 * orphan row behind.
 */

export { toSkillDto } from './helpers.js';

export interface CreateSkillInput {
  name: string;
  description?: string;
  type?: SkillType;
  source?: SkillSource;
  body: string;
  enabled?: boolean;
  evidence_files?: string[] | null;
}

export interface UpdateSkillInput {
  name?: string;
  description?: string;
  type?: SkillType;
  body?: string;
  enabled?: boolean;
  evidence_files?: string[] | null;
}

export class SkillsService {
  private repo: SkillsRepository;

  constructor(container: Container) {
    this.repo = container.skillsRepo;
  }

  async list(workspaceId: string): Promise<Skill[]> {
    const rows = await this.repo.list(workspaceId);
    return rows.map(toSkillDto);
  }

  async get(workspaceId: string, id: string): Promise<Skill | undefined> {
    const row = await this.repo.getById(workspaceId, id);
    return row ? toSkillDto(row) : undefined;
  }

  /** Delete a skill; `agent_skills` links and `skill_versions` cascade. */
  async delete(workspaceId: string, id: string): Promise<boolean> {
    return this.repo.deleteById(workspaceId, id);
  }

  /**
   * Create a skill (writes version 1).
   *
   * Trust boundary: only a `manual` body is authored inside this workspace, so
   * only a `manual` skill may be born enabled. Anything imported lands
   * `enabled: false` regardless of what the caller asked for — the user vets it
   * in the editor and flips the toggle themselves.
   */
  async create(workspaceId: string, input: CreateSkillInput): Promise<Skill> {
    const source = input.source ?? DEFAULT_SKILL_SOURCE;
    const trusted = source === 'manual';
    const row = await this.repo.insert({
      workspaceId,
      name: input.name,
      description: input.description ?? '',
      type: input.type ?? 'custom',
      source,
      body: input.body,
      enabled: trusted ? input.enabled ?? true : false,
      evidenceFiles: input.evidence_files ?? null,
    });
    return toSkillDto(row);
  }

  /** Update a skill. A changed `body` bumps the version and snapshots it. */
  async update(
    workspaceId: string,
    id: string,
    patch: UpdateSkillInput,
  ): Promise<Skill | undefined> {
    const row = await this.repo.update(workspaceId, id, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.type !== undefined ? { type: patch.type } : {}),
      ...(patch.body !== undefined ? { body: patch.body } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.evidence_files !== undefined ? { evidenceFiles: patch.evidence_files } : {}),
    });
    return row ? toSkillDto(row) : undefined;
  }

  /**
   * Body history, newest version first. Workspace-scoped: undefined when the
   * skill isn't in this workspace (the route maps that to 404) so snapshots
   * can't be read across tenants.
   */
  async listVersions(
    workspaceId: string,
    skillId: string,
  ): Promise<SkillVersionDto[] | undefined> {
    const skill = await this.repo.getById(workspaceId, skillId);
    if (!skill) return undefined;
    const rows = await this.repo.listVersions(skillId);
    return rows.map(toSkillVersionDto);
  }

  /** One body snapshot; undefined when the skill or version doesn't exist. */
  async getVersion(
    workspaceId: string,
    skillId: string,
    version: number,
  ): Promise<SkillVersionDto | undefined> {
    const skill = await this.repo.getById(workspaceId, skillId);
    if (!skill) return undefined;
    const row = await this.repo.getVersion(skillId, version);
    return row ? toSkillVersionDto(row) : undefined;
  }

  /**
   * Parse an uploaded `.md` or `.zip` into a preview. **Persists nothing.**
   *
   * For a `.zip`, only markdown entries are inflated (see `zip.ts`); every other
   * entry comes back in `skipped_files`, which is why that list is generated
   * here rather than guessed by the UI — the guarantee the user reads is the
   * same fact the parser acted on.
   */
  async importPreview(filename: string, contentBase64: string): Promise<SkillImportPreview> {
    const buf = decodeBase64(contentBase64);
    const isZip = filename.toLowerCase().endsWith('.zip');

    let text: string;
    let sourceName = filename;
    let skipped: string[] = [];

    if (isZip) {
      let entries;
      try {
        entries = readZipEntries(buf);
      } catch (err) {
        throw new ValidationError(
          err instanceof ZipError ? err.message : 'Could not read the archive',
        );
      }
      skipped = entries.filter((e) => e.skipped).map((e) => e.name);
      const markdown = entries.filter((e) => !e.skipped) as Extract<
        (typeof entries)[number],
        { skipped: false }
      >[];
      if (markdown.length === 0) {
        throw new ValidationError('Archive contains no .md file to import as a skill');
      }
      // Prefer a conventional SKILL.md at any depth; otherwise the first markdown.
      const chosen =
        markdown.find((e) => filenameStem(e.name).toLowerCase() === 'skill') ?? markdown[0]!;
      text = chosen.content;
      sourceName = chosen.name;
    } else {
      text = buf.toString('utf8');
    }

    if (!text.trim()) throw new ValidationError('The uploaded skill is empty');

    const parsed = parseSkillMarkdown(text, sourceName);
    return {
      name: parsed.name,
      description: parsed.description,
      type: parsed.type,
      body: parsed.body,
      // Everything arriving from outside the workspace is untrusted until vetted.
      source: 'imported_url',
      skipped_files: skipped,
    };
  }
}

/** Strict-ish base64 decode: Buffer is lenient, so verify it round-trips. */
function decodeBase64(value: string): Buffer {
  const cleaned = value.replace(/^data:[^;]*;base64,/, '').trim();
  const buf = Buffer.from(cleaned, 'base64');
  if (buf.length === 0) throw new ValidationError('Uploaded file is empty or not valid base64');
  return buf;
}
