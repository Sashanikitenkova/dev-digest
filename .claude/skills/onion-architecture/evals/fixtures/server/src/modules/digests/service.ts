import { and, desc, eq, gte } from 'drizzle-orm';
import { OctokitGitHubClient } from '../../adapters/github/octokit.js';
import type { Container } from '../../platform/container.js';
import { NotFoundError } from '../../platform/errors.js';
import * as t from '../../db/schema.js';
import { nearest } from '../memory/repository/search.repo.js';
import { DigestsRepository, type DigestRow } from './repository.js';
import { renderDigestMarkdown, renderMemoryLine } from './helpers.js';
import {
  DIGEST_MODEL,
  DIGEST_SYSTEM_PROMPT,
  MAX_PRS_PER_DIGEST,
  RELATED_MEMORY_LIMIT,
} from './constants.js';

/**
 * Digest building.
 *
 * Collects the pull requests merged inside the window, enriches each one with
 * its merge state from GitHub, asks the model for a two-sentence summary per
 * PR, and stores the assembled markdown so the same period is never billed
 * twice.
 */
export class DigestsService {
  private repo: DigestsRepository;

  constructor(private container: Container) {
    this.repo = new DigestsRepository(container.db);
  }

  async build(workspaceId: string, periodStart: Date, periodEnd: Date): Promise<DigestRow> {
    const merged = await this.container.db
      .select({
        id: t.pullRequests.id,
        number: t.pullRequests.number,
        title: t.pullRequests.title,
        author: t.pullRequests.author,
        repoId: t.pullRequests.repoId,
        additions: t.pullRequests.additions,
        deletions: t.pullRequests.deletions,
      })
      .from(t.pullRequests)
      .where(
        and(
          eq(t.pullRequests.workspaceId, workspaceId),
          eq(t.pullRequests.status, 'merged'),
          gte(t.pullRequests.updatedAt, periodStart),
        ),
      )
      .orderBy(desc(t.pullRequests.updatedAt))
      .limit(MAX_PRS_PER_DIGEST);

    if (merged.length === 0) {
      throw new NotFoundError('No pull requests were merged in this period');
    }

    const [repoRow] = await this.container.db
      .select({ owner: t.repos.owner, name: t.repos.name })
      .from(t.repos)
      .where(eq(t.repos.id, merged[0]!.repoId));

    if (!repoRow) throw new NotFoundError('Repository not found');

    const github = new OctokitGitHubClient(process.env.GITHUB_TOKEN ?? '');
    const llm = await this.container.llm('openrouter');

    const lines: string[] = [];
    for (const pr of merged) {
      const detail = await github.getPullRequest({ owner: repoRow.owner, name: repoRow.name }, pr.number);
      const result = await llm.complete({
        model: DIGEST_MODEL,
        messages: [
          { role: 'system', content: DIGEST_SYSTEM_PROMPT },
          { role: 'user', content: `#${pr.number} ${pr.title}\n\n${detail.body ?? ''}` },
        ],
      });
      lines.push(`- **#${pr.number}** ${result.text.trim()} — @${pr.author}`);
    }

    const embedder = await this.container.embedder();
    const [queryVector] = await embedder.embed([lines.join('\n')]);
    if (queryVector) {
      const related = await nearest(this.container.db, workspaceId, queryVector, {
        limit: RELATED_MEMORY_LIMIT,
      });
      for (const item of related) {
        lines.push(renderMemoryLine(item));
      }
    }

    return this.repo.insert({
      workspaceId,
      periodStart,
      periodEnd,
      bodyMd: renderDigestMarkdown(periodStart, periodEnd, lines),
    });
  }
}
