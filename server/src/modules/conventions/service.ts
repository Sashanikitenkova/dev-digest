import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type {
  ConventionCandidate,
  ConventionExtractResult,
  ConventionStatus,
} from '@devdigest/shared';
import type { Container } from '../../platform/container.js';
import { ValidationError } from '../../platform/errors.js';
import { getFeatureModelOverride } from '../settings/feature-models.js';
import { ConventionsRepository, type InsertConvention } from './repository.js';
import {
  capLines,
  groundCandidate,
  renderSamples,
  toConventionDto,
  type FileSample,
} from './helpers.js';
import {
  DEFAULT_CONVENTIONS_MODEL,
  EXTRACT_MAX_RETRIES,
  EXTRACT_TIMEOUT_MS,
  MAX_SAMPLE_CHARS,
  SAMPLE_FILE_COUNT,
} from './constants.js';

/**
 * Conventions extractor.
 *
 * The model PROPOSES house-rules; code DECIDES which survive. Every candidate
 * is re-checked against the clone (file exists, line in range, snippet matches
 * that line) before anything is persisted — the same grounding discipline the
 * review pipeline applies to findings. A rule the model invented about code
 * that isn't there is worse than no rule at all, because it would be merged
 * into a Skill and injected into every future review.
 */

/**
 * Minimal structured-log sink, satisfied by Fastify's `req.log.info`. Passed in
 * from the route rather than pulled off the container: services here don't own
 * a logger, and the drop reasons are the one thing a 0-kept run needs to be
 * diagnosable from the server output.
 */
export type ExtractLogger = (obj: Record<string, unknown>, msg: string) => void;

/** What we ask the model for. Deliberately loose on `line` — the gate re-checks it. */
const ProposedConvention = z.object({
  category: z.string(),
  rule: z.string(),
  evidence: z.object({
    file: z.string(),
    line: z.number().int(),
    snippet: z.string(),
  }),
  confidence: z.number().min(0).max(1),
});

const ProposedConventions = z.object({
  conventions: z.array(ProposedConvention),
});

const SYSTEM_PROMPT = `You extract UNWRITTEN house conventions from a codebase.

A convention is a rule this team follows consistently that a new contributor could
not guess and that no linter already enforces.

Rules:
- Do NOT report anything eslint or prettier already enforces (quote style, semicolons,
  indentation, trailing commas, line length, import order).
- Do NOT report generic best practice ("use meaningful names", "handle errors").
  Only report what is specifically true of THIS codebase.
- Every convention MUST cite real evidence: a file from the samples, the line number
  as shown in the "N: " prefix, and the exact snippet text at that line.
- Quote the snippet verbatim from the sample. Do not paraphrase, reformat, or invent.
- If you are not confident a rule is real, omit it. Few precise conventions beat many
  speculative ones.

Return each convention with: category (e.g. "error-handling", "naming", "structure",
"api", "testing"), rule (one directive sentence), evidence {file, line, snippet}, and
confidence between 0 and 1.`;

export class ConventionsService {
  private repo: ConventionsRepository;

  constructor(private container: Container) {
    this.repo = new ConventionsRepository(container.db);
  }

  async list(workspaceId: string, repoId: string): Promise<ConventionCandidate[]> {
    const rows = await this.repo.listByRepo(workspaceId, repoId);
    return rows.map(toConventionDto);
  }

  async setStatus(
    workspaceId: string,
    id: string,
    status: ConventionStatus,
  ): Promise<ConventionCandidate | undefined> {
    const row = await this.repo.setStatus(workspaceId, id, status);
    return row ? toConventionDto(row) : undefined;
  }

  /**
   * Sample → propose → GROUND → persist.
   *
   * Returns the proposed/kept/dropped counts alongside the survivors so the UI
   * can distinguish "the repo has no unwritten conventions" from "the model
   * proposed eight and every one was fabricated".
   */
  async extract(
    workspaceId: string,
    repoId: string,
    log?: ExtractLogger,
  ): Promise<ConventionExtractResult> {
    const repo = await this.repo.getRepo(workspaceId, repoId);
    if (!repo) throw new ValidationError('Repo not found');
    if (!repo.clonePath) {
      throw new ValidationError(
        'Repo has no clone yet — wait for the clone job to finish, then re-scan.',
      );
    }

    // 1. Which files to look at. NOTE: this returns PATHS ONLY (it wraps
    //    getTopFilesByRank), and it returns [] when repo-intel is disabled or
    //    the repo has not been indexed yet.
    const paths = await this.container.repoIntel.getConventionSamples(repoId, SAMPLE_FILE_COUNT);
    if (paths.length === 0) {
      throw new ValidationError(
        'No sample files available — the repo index is empty. Wait for indexing to finish (or re-index) and try again.',
      );
    }

    // 2. Read them off the clone ourselves.
    const samples: FileSample[] = [];
    for (const path of paths) {
      const source = await readFile(join(repo.clonePath, path), 'utf8').catch(() => null);
      if (source == null) continue;
      samples.push({ path, lines: capLines(source) });
    }
    if (samples.length === 0) {
      throw new ValidationError('Sampled files could not be read from the clone.');
    }
    const byPath = new Map(samples.map((s) => [s.path, s]));

    // 3. One cheap-model call. `completeStructured` handles schema enforcement
    //    and retries, so there is no bespoke JSON parsing here.
    const choice =
      (await getFeatureModelOverride(this.container, workspaceId, 'conventions')) ??
      DEFAULT_CONVENTIONS_MODEL;
    const llm = await this.container.llm(choice.provider);

    const result = await llm.completeStructured({
      model: choice.model,
      schema: ProposedConventions,
      schemaName: 'conventions',
      temperature: 0,
      timeoutMs: EXTRACT_TIMEOUT_MS,
      maxRetries: EXTRACT_MAX_RETRIES,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content:
            `Repository: ${repo.fullName}\n\n` +
            `Sampled files (line numbers are shown as "N: " prefixes — cite them exactly):\n\n` +
            renderSamples(samples, MAX_SAMPLE_CHARS),
        },
      ],
    });

    const proposals = result.data.conventions;

    // 4. THE GROUNDING GATE — the model does not get the final say.
    const kept: InsertConvention[] = [];
    const dropReasons: string[] = [];
    for (const p of proposals) {
      const check = groundCandidate(
        {
          evidence_path: p.evidence.file,
          evidence_line: p.evidence.line,
          evidence_snippet: p.evidence.snippet,
        },
        byPath,
      );
      if (!check.ok) {
        dropReasons.push(`${p.evidence.file}:${p.evidence.line} — ${check.reason}`);
        continue;
      }
      kept.push({
        workspaceId,
        repoId,
        category: p.category || null,
        rule: p.rule,
        evidencePath: p.evidence.file,
        evidenceLine: p.evidence.line,
        evidenceSnippet: p.evidence.snippet,
        confidence: p.confidence,
      });
    }

    if (dropReasons.length > 0) {
      log?.(
        { dropped: dropReasons },
        `conventions: dropped ${dropReasons.length}/${proposals.length} ungrounded candidate(s)`,
      );
    }

    // 5. Replace only the untriaged rows, then persist the survivors.
    await this.repo.deletePending(workspaceId, repoId);
    const rows = await this.repo.insertMany(kept);

    return {
      proposed: proposals.length,
      kept: rows.length,
      dropped: proposals.length - rows.length,
      sampled_files: samples.length,
      candidates: rows.map(toConventionDto),
    };
  }
}
