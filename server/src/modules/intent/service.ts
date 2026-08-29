import type { IntentForPrompt } from '@devdigest/reviewer-core';
import type { IntentSource, PrIntentRecord, UnifiedDiff } from '@devdigest/shared';
import type { Container } from '../../platform/container.js';
import type { PullRow } from '../../db/rows.js';
import type { RunLogger } from '../../platform/run-logger.js';
import { ExternalServiceError, NotFoundError, ValidationError } from '../../platform/errors.js';
import { resolveFeatureModel } from '../settings/feature-models.js';
import { loadDiff } from '../reviews/diff-loader.js';
import { IntentRepository, type PrIntentRow, type RepoRow } from './repository.js';
import { ClassifiedIntent, SYSTEM_PROMPT, buildClassifierUser } from './prompt.js';
import {
  computeConfidence,
  describeSources,
  extractIssueNumber,
  extractSpecPaths,
  extractUrls,
  isFresh,
  isSubstantialBody,
  renderHunkHeaders,
  safeRepoRelativePath,
  toIntentDto,
  toPromptIntent,
} from './helpers.js';
import {
  DETECT_MAX_RETRIES,
  DETECT_TIMEOUT_MS,
  MAX_BODY_CHARS,
  MAX_ISSUE_CHARS,
  MAX_SCOPE_ENTRIES,
  MAX_SPEC_CHARS,
  MAX_SPEC_FILES,
  MAX_URL_SOURCES,
} from './constants.js';

/**
 * PR intent classification — the cheap call that runs BEFORE the review.
 *
 * The shape mirrors `ConventionsService`: a cheap model proposes, code decides.
 * Here "code decides" means three things the model has no say in —
 *
 *   1. WHICH SOURCES EXIST. The service records every input as `used` or
 *      `missing` with a reason. A link it could not follow is reported as
 *      missing, never quietly replaced with something plausible.
 *   2. HOW CONFIDENT THE RESULT IS. `computeConfidence` derives a ceiling from
 *      the sources actually assembled; the model's self-reported number can
 *      only lower it (self-reported LLM confidence is poorly calibrated).
 *   3. WHAT THE SCOPE DOES. The scope list is advisory prompt context plus
 *      input to `applyScopeFilter` in reviewer-core, which demotes but never
 *      deletes and never touches a CRITICAL/security/correctness finding.
 *
 * External URLs are NEVER fetched (v1). The server has no HTTP-fetch port, and
 * adding one would mean full OWASP SSRF controls on a tool running next to a
 * developer's localhost services — while the fetched document would itself be a
 * fresh injection vector. Repo-relative docs come off the clone instead, behind
 * `safeRepoRelativePath`.
 */

/** Minimal structured-log sink, satisfied by Fastify's `req.log.info`. */
export type IntentLogger = (obj: Record<string, unknown>, msg: string) => void;

/** Assembled classifier inputs plus the source ledger describing them. */
interface AssembledContext {
  body?: string;
  issue?: { number: number; title: string; body?: string };
  specs: { path: string; content: string }[];
  fileList: string;
  sources: IntentSource[];
  /** Human-readable notes for the prompt's "could NOT be retrieved" section. */
  missing: string[];
}

export class IntentService {
  private repo: IntentRepository;

  constructor(private container: Container) {
    this.repo = new IntentRepository(container.db);
  }

  /** The stored intent for a PR, or `null` when it has never been detected. */
  async get(workspaceId: string, prId: string): Promise<PrIntentRecord | null> {
    const found = await this.repo.getPullWithRepo(workspaceId, prId);
    if (!found) throw new NotFoundError('Pull request not found');
    const row = await this.repo.getByPr(prId);
    return row ? toIntentDto(row) : null;
  }

  /**
   * Classify a PR's intent and persist it (one row per PR, upserted).
   *
   * Throws only for caller errors (unknown PR, no loadable diff) and for a hard
   * LLM failure on the EXPLICIT path — the review path calls `ensureFresh`,
   * which swallows those.
   */
  async detect(
    workspaceId: string,
    prId: string,
    opts: { diff?: UnifiedDiff; log?: IntentLogger } = {},
  ): Promise<PrIntentRecord> {
    const found = await this.repo.getPullWithRepo(workspaceId, prId);
    if (!found) throw new NotFoundError('Pull request not found');
    const { pull, repo } = found;

    const diff = opts.diff ?? (await this.loadDiffFor(workspaceId, pull, repo));
    if (diff.files.length === 0) {
      throw new ValidationError(
        'No diff available for this PR yet — wait for the clone/import to finish, then re-detect.',
      );
    }

    const { row } = await this.classifyAndPersist(workspaceId, pull, repo, diff, opts.log);
    return toIntentDto(row);
  }

  /**
   * The review-run entry point: return a usable intent for the CURRENT head,
   * re-classifying only when the stored row is absent or stale.
   *
   * Best-effort by contract — it never throws. A failure is logged to the run's
   * Live Log and the review proceeds with no `## Intent` section, producing a
   * prompt byte-identical to the pre-intent one.
   */
  async ensureFresh(
    workspaceId: string,
    pull: PullRow,
    repo: RepoRow,
    diff: UnifiedDiff,
    runLog: RunLogger,
  ): Promise<{ intent: IntentForPrompt; row: PrIntentRow; durationMs: number } | undefined> {
    try {
      const existing = await this.repo.getByPr(pull.id);
      if (isFresh(existing, pull.headSha)) {
        const row = existing!;
        runLog.info(
          `intent: reusing intent for ${pull.headSha.slice(0, 7)} ` +
            `(detected ${row.generatedAt.toISOString()})`,
        );
        // 0 ms is honest here: this round made no classifier call.
        return { intent: toPromptIntent(row), row, durationMs: 0 };
      }

      const { row, durationMs } = await this.classifyAndPersist(
        workspaceId,
        pull,
        repo,
        diff,
        undefined,
        runLog,
      );
      return { intent: toPromptIntent(row), row, durationMs };
    } catch (err) {
      runLog.info(
        `intent: detection failed — ${(err as Error).message}; continuing without intent`,
      );
      return undefined;
    }
  }

  // =========================================================================
  // internals
  // =========================================================================

  private async loadDiffFor(
    workspaceId: string,
    pull: PullRow,
    repo: RepoRow,
  ): Promise<UnifiedDiff> {
    // `loadDiff` needs a ReviewRepository purely for its pr_files fallback.
    // Taken from the composition root rather than constructed here, so a change
    // to how the container builds it reaches this path too.
    return loadDiff(this.container, this.container.reviewRepo, workspaceId, pull, repo);
  }

  /** Assemble sources → one cheap LLM call → compute confidence → upsert. */
  private async classifyAndPersist(
    workspaceId: string,
    pull: PullRow,
    repo: RepoRow,
    diff: UnifiedDiff,
    log?: IntentLogger,
    runLog?: RunLogger,
  ): Promise<{ row: PrIntentRow; durationMs: number }> {
    const ctx = await this.assembleContext(pull, repo, diff);

    const choice = await resolveFeatureModel(this.container, workspaceId, 'review_intent');
    const llm = await this.container.llm(choice.provider);

    const user = buildClassifierUser({
      title: pull.title,
      author: pull.author,
      number: pull.number,
      repoFullName: repo.fullName,
      ...(ctx.body ? { body: ctx.body } : {}),
      ...(ctx.issue ? { issue: ctx.issue } : {}),
      ...(ctx.specs.length > 0 ? { specs: ctx.specs } : {}),
      fileList: ctx.fileList,
      missing: ctx.missing,
    });

    runLog?.tool(`LLM call 1/2 — intent classifier (${choice.provider}/${choice.model})`);

    const startedAt = Date.now();
    // `completeStructured` already reprompts `DETECT_MAX_RETRIES` times. A miss
    // that survives that is a model-choice problem (OpenRouter documents that
    // some providers treat a JSON schema as a hint), so say so plainly instead
    // of surfacing a bare 500. `ensureFresh` catches this on the review path.
    let result;
    try {
      result = await llm.completeStructured({
        model: choice.model,
        schema: ClassifiedIntent,
        schemaName: 'intent',
        temperature: 0,
        timeoutMs: DETECT_TIMEOUT_MS,
        maxRetries: DETECT_MAX_RETRIES,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: user },
        ],
      });
    } catch (err) {
      throw new ExternalServiceError(
        `Intent classifier (${choice.provider}/${choice.model}) failed: ${(err as Error).message}. ` +
          `Pick a model that supports structured outputs in Settings → Models.`,
      );
    }

    const durationMs = Date.now() - startedAt;

    // The model's number is an INPUT to the ceiling, never the answer.
    const { confidence, level } = computeConfidence(ctx.sources, result.data.confidence);

    const row = await this.repo.upsert({
      prId: pull.id,
      intent: result.data.intent.trim(),
      inScope: cleanScope(result.data.in_scope),
      outOfScope: cleanScope(result.data.out_of_scope),
      headSha: pull.headSha,
      confidence,
      confidenceLevel: level,
      sources: ctx.sources.map((s) => ({
        kind: s.kind,
        ref: s.ref ?? null,
        status: s.status,
        reason: s.reason ?? null,
      })),
      provider: choice.provider,
      model: choice.model,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      costUsd: result.costUsd,
    });

    // Source KINDS and short refs only — never the fetched content, never a key.
    const summary = `intent: confidence ${level} (${confidence}) · ${describeSources(ctx.sources)}`;
    runLog?.result(summary);
    log?.(
      {
        prId: pull.id,
        provider: choice.provider,
        model: choice.model,
        confidence,
        confidenceLevel: level,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        durationMs,
        sources: ctx.sources.map((s) => `${s.kind}:${s.status}`),
      },
      summary,
    );

    return { row, durationMs };
  }

  /**
   * Gather every allowed input and record a `used`/`missing` entry for each.
   *
   * The ledger is the feature's honesty guarantee: whatever the model then says,
   * the UI and the log can state exactly what the system did and did not know.
   */
  private async assembleContext(
    pull: PullRow,
    repo: RepoRow,
    diff: UnifiedDiff,
  ): Promise<AssembledContext> {
    const sources: IntentSource[] = [{ kind: 'title', ref: null, status: 'used', reason: null }];
    const missing: string[] = [];

    // ---- body ------------------------------------------------------------
    const rawBody = (pull.body ?? '').trim();
    let body: string | undefined;
    if (rawBody.length === 0) {
      sources.push({ kind: 'body', ref: null, status: 'missing', reason: 'empty_body' });
      missing.push('The PR has no description.');
    } else {
      body = rawBody.slice(0, MAX_BODY_CHARS);
      if (isSubstantialBody(rawBody)) {
        sources.push({ kind: 'body', ref: null, status: 'used', reason: null });
      } else {
        // Still sent (it is context) but too thin to raise the confidence ceiling.
        sources.push({ kind: 'body', ref: null, status: 'missing', reason: 'body_too_short' });
        missing.push('The PR description is very short and may not state the full intent.');
      }
    }

    // ---- linked issue ----------------------------------------------------
    const issueNumber = extractIssueNumber(pull.body);
    let issue: AssembledContext['issue'];
    if (issueNumber != null) {
      try {
        const gh = await this.container.github();
        const fetched = await gh.getIssue({ owner: repo.owner, name: repo.name }, issueNumber);
        issue = {
          number: fetched.number,
          title: fetched.title,
          ...(fetched.body ? { body: fetched.body.slice(0, MAX_ISSUE_CHARS) } : {}),
        };
        sources.push({
          kind: 'linked_issue',
          ref: `#${issueNumber}`,
          status: 'used',
          reason: null,
        });
      } catch (err) {
        sources.push({
          kind: 'linked_issue',
          ref: `#${issueNumber}`,
          status: 'missing',
          reason: 'github_unavailable',
        });
        missing.push(
          `Issue #${issueNumber} is referenced but could not be retrieved (${(err as Error).message}).`,
        );
      }
    }

    // ---- plan / spec docs off the clone ----------------------------------
    const specs: { path: string; content: string }[] = [];
    for (const candidate of extractSpecPaths(pull.body)) {
      if (specs.length >= MAX_SPEC_FILES) break;
      // The containment gate sits HERE, immediately before the read, because
      // `GitClient.readFile` joins onto the clone dir without validating.
      const safe = safeRepoRelativePath(candidate);
      if (!safe) {
        sources.push({
          kind: 'spec_file',
          ref: candidate,
          status: 'missing',
          reason: 'unsafe_path',
        });
        missing.push(`Referenced path "${candidate}" was rejected as unsafe and not read.`);
        continue;
      }
      try {
        const content = await this.container.git.readFile(
          { owner: repo.owner, name: repo.name },
          safe,
        );
        // An empty read is "no usable plan", not a plan that says nothing — and
        // it is what a clone miss looks like on some GitClient implementations.
        // Reported as missing either way; the model is never handed a blank doc
        // and told it is the spec.
        if (content.trim().length === 0) {
          sources.push({ kind: 'spec_file', ref: safe, status: 'missing', reason: 'empty_file' });
          missing.push(`Plan/spec "${safe}" is referenced but is empty in the clone.`);
          continue;
        }
        specs.push({ path: safe, content: content.slice(0, MAX_SPEC_CHARS) });
        sources.push({ kind: 'spec_file', ref: safe, status: 'used', reason: null });
      } catch {
        sources.push({ kind: 'spec_file', ref: safe, status: 'missing', reason: 'not_in_clone' });
        missing.push(`Plan/spec "${safe}" is referenced but is not present in the clone.`);
      }
    }

    // ---- external links: recorded, never fetched -------------------------
    const urls = extractUrls(pull.body).slice(0, MAX_URL_SOURCES);
    for (const url of urls) {
      sources.push({
        kind: 'url',
        ref: url,
        status: 'missing',
        reason: 'external_fetch_disabled',
      });
    }
    if (urls.length > 0) {
      missing.push(
        `${urls.length} external link(s) in the description were NOT opened; their contents are unknown.`,
      );
    }

    // ---- changed files: names + hunk headers, never bodies ---------------
    const fileList = renderHunkHeaders(diff);
    sources.push({ kind: 'file_list', ref: `${diff.files.length} file(s)`, status: 'used', reason: null });

    return { ...(body ? { body } : {}), ...(issue ? { issue } : {}), specs, fileList, sources, missing };
  }
}

/** Trim, drop empties, dedupe, and cap — the model's list is not trusted raw. */
function cleanScope(entries: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of entries) {
    const entry = raw.trim();
    if (!entry) continue;
    const key = entry.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
    if (out.length >= MAX_SCOPE_ENTRIES) break;
  }
  return out;
}
