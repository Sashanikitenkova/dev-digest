import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { ContextListing, SpecFile, SpecFileContent } from '@devdigest/shared';
import type { Container } from '../../platform/container.js';
import { NotFoundError, ValidationError } from '../../platform/errors.js';
import { walkClone } from '../repo-intel/pipeline/walk.js';
import { ContextRepository, type ContextOwnerKind } from './repository.js';
import { CONTEXT_EXTENSIONS } from './constants.js';
import { contextTokens, documentType, mergeAttachments, safeContextPath } from './helpers.js';

/**
 * Project-context application service (SPEC-01).
 *
 * Discovery is a LIVE WALK of the clone on every request — there is no index,
 * no cache and no reindex endpoint. The documents are a handful of markdown
 * files under two or three roots, so walking them costs less than the
 * invalidation logic an index would need, and a freshly-`git pull`ed document
 * shows up without anyone pressing a button.
 */
export class ContextService {
  private repo: ContextRepository;

  constructor(private container: Container) {
    this.repo = new ContextRepository(container.db);
  }

  private get roots(): string[] {
    return this.container.config.contextRoots;
  }

  /**
   * Discover every `.md` document under the configured roots of a repo's clone.
   *
   * `cloned: false` (no `repos.clone_path`) is a normal answer, not an error:
   * a repo can be added before it is cloned, and "not cloned yet" is a
   * different fact from "no documents", which the UI renders differently.
   */
  async listDocuments(workspaceId: string, repoId: string): Promise<ContextListing> {
    const repo = await this.repo.getRepo(workspaceId, repoId);
    if (!repo) throw new NotFoundError('Repo not found');

    const roots = this.roots;
    if (!repo.clonePath) {
      return { cloned: false, roots, files: [], total_tokens: 0 };
    }

    // Reuses the indexer's walker, so this walk inherits EXCLUDED_DIRS, the
    // 400 KB per-file cap, the 5 000-file bound and the never-follow-symlinks
    // rule instead of re-earning them. `dirFilter` prunes at the top level so a
    // large repo is not traversed in full to find `specs/`.
    const walk = await walkClone(repo.clonePath, {
      extensions: CONTEXT_EXTENSIONS,
      dirFilter: (_name, relPath) => {
        const first = relPath.split('/')[0] ?? '';
        return roots.includes(first);
      },
    });

    const usedBy = await this.repo.countAgentAttachmentsByPath(workspaceId);

    const files: SpecFile[] = [];
    let total = 0;
    for (const path of walk.files) {
      const type = documentType(path, roots);
      // A file the walker surfaced but that resolves to no configured root
      // cannot happen while dirFilter and documentType share `roots`; skipping
      // rather than defaulting keeps that invariant enforced instead of assumed.
      if (!type) continue;
      let content: string;
      try {
        content = await readFile(join(repo.clonePath, path), 'utf8');
      } catch {
        // Vanished between walk and read (a concurrent resync) — omit it rather
        // than report a document nobody can open.
        continue;
      }
      const tokens = contextTokens(content);
      total += tokens;
      files.push({
        path,
        type,
        bytes: Buffer.byteLength(content, 'utf8'),
        tokens,
        used_by_agents: usedBy.get(path) ?? 0,
      });
    }

    return { cloned: true, roots, files, total_tokens: total };
  }

  /** One document's body, for the read-only preview. */
  async readDocument(
    workspaceId: string,
    repoId: string,
    path: string,
  ): Promise<SpecFileContent> {
    const repo = await this.repo.getRepo(workspaceId, repoId);
    if (!repo) throw new NotFoundError('Repo not found');
    if (!repo.clonePath) throw new NotFoundError('Repo is not cloned');

    // The containment gate sits immediately before the read, where the
    // dangerous operation is — the same placement the intent module uses.
    const safe = safeContextPath(path);
    if (!safe) throw new ValidationError('Unsafe or unsupported document path');

    let content: string;
    try {
      content = await readFile(join(repo.clonePath, safe), 'utf8');
    } catch {
      throw new NotFoundError('Document not found in the clone');
    }
    // Report the on-disk size, which can differ from the string length for any
    // non-ASCII document.
    const bytes = await stat(join(repo.clonePath, safe))
      .then((st) => st.size)
      .catch(() => Buffer.byteLength(content, 'utf8'));
    return { path: safe, content, bytes, tokens: contextTokens(content) };
  }

  // ---------------------------------------------------------- attachments

  async getAttachments(
    workspaceId: string,
    kind: ContextOwnerKind,
    ownerId: string,
  ): Promise<string[]> {
    await this.assertOwner(workspaceId, kind, ownerId);
    return this.repo.list(kind, ownerId);
  }

  /**
   * Replace an owner's whole ordered attachment set.
   *
   * EVERY path is validated BEFORE anything is written, and the first failure
   * rejects the whole submission — a partial write would leave the author with
   * an attachment set they never asked for and no indication which entry was
   * dropped.
   *
   * Deliberately does NOT route through `AgentsService.update` /
   * `SkillsService.update`: attaching a document is not a change to the agent's
   * configuration or the skill's body, so it must not bump `agents.version` /
   * `skills.version` or write a version-history row (AC-11).
   */
  async setAttachments(
    workspaceId: string,
    kind: ContextOwnerKind,
    ownerId: string,
    paths: string[],
  ): Promise<string[]> {
    await this.assertOwner(workspaceId, kind, ownerId);

    const safe: string[] = [];
    const seen = new Set<string>();
    for (const raw of paths) {
      const ok = safeContextPath(raw);
      if (!ok) throw new ValidationError(`Unsafe or unsupported document path: ${raw}`);
      // The table's PK is (owner, path), so a duplicate would abort the insert
      // mid-transaction. Collapse it here, keeping the first position.
      if (seen.has(ok)) continue;
      seen.add(ok);
      safe.push(ok);
    }

    return this.repo.replace(kind, ownerId, safe);
  }

  /**
   * The documents ONE agent's next review should read: the agent's own
   * attachments first, then those inherited from each linked skill that passes
   * BOTH enable flags, in link order.
   *
   * Both flags matter and they are independent, exactly as they are for skill
   * blocks: `agent_skills.enabled` (this agent's per-link checkbox) AND
   * `skills.enabled` (the skill is live at all). A disabled skill must not
   * smuggle its documents into the prompt.
   */
  async resolveForRun(agentId: string): Promise<string[]> {
    const own = await this.repo.list('agent', agentId);

    const links = await this.container.agentsRepo.linkedSkills(agentId);
    const active = links.filter((l) => l.enabled && l.skill.enabled);
    const bySkill = await this.repo.listForSkills(active.map((l) => l.skill.id));

    // `linkedSkills` already returns `order` ascending, so mapping preserves
    // link order — which is what makes drag-to-reorder change the prompt.
    return mergeAttachments(
      own,
      active.map((l) => ({ skillId: l.skill.id, paths: bySkill.get(l.skill.id) ?? [] })),
    );
  }

  private async assertOwner(
    workspaceId: string,
    kind: ContextOwnerKind,
    ownerId: string,
  ): Promise<void> {
    const exists =
      kind === 'agent'
        ? await this.repo.agentExists(workspaceId, ownerId)
        : await this.repo.skillExists(workspaceId, ownerId);
    if (!exists) throw new NotFoundError(kind === 'agent' ? 'Agent not found' : 'Skill not found');
  }
}
