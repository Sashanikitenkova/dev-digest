import type {
  BlastRadius,
  PrRiskBriefRecord,
  Risk,
  RiskBriefInputEntry,
  UnifiedDiff,
} from '@devdigest/shared';
import type { Container } from '../../platform/container.js';
import type { PullRow } from '../../db/rows.js';
import { AppError, ExternalServiceError, NotFoundError } from '../../platform/errors.js';
import { resolveFeatureModel } from '../settings/feature-models.js';
import { loadDiff } from '../reviews/diff-loader.js';
import { IntentService } from '../intent/service.js';
import { BlastService } from '../blast/service.js';
import { RisksService } from '../risks/service.js';
import { ContextService } from '../context/service.js';
import { extractIssueNumber } from '../intent/helpers.js';
import {
  MAX_BODY_CHARS,
  MAX_FILES_IN_PROMPT,
  MAX_HUNKS_PER_FILE,
  MAX_ISSUE_CHARS,
} from '../intent/constants.js';
import { BriefRepository, type BriefPayload, type RepoRow } from './repository.js';
import {
  DraftedBrief,
  SYSTEM_PROMPT,
  buildBriefUser,
  type BriefParts,
  type BriefRiskAreaPart,
} from './prompt.js';
import {
  boundProtected,
  buildAllowlist,
  buildValidLineIndex,
  isFreshBrief,
  protectedOnly,
  shedToBudget,
  toBriefDto,
  validateItems,
} from './helpers.js';
import {
  assertEncoderIntact,
  assertFloorFits,
  assertWithinBudget,
  fixedOverheadTokens,
  payloadTokens,
} from './budget.js';
import {
  BRIEF_MAX_COMPLETION_TOKENS,
  BRIEF_MAX_RETRIES,
  BRIEF_SCHEMA_NAME,
  BRIEF_TIMEOUT_MS,
  MAX_CONTEXT_PATHS,
} from './constants.js';

/**
 * The Why + Risk brief — one structured model call per distinct PR state.
 *
 * The shape mirrors the intent classifier: a model proposes, code decides.
 * Here "code decides" means four things the model has no say in —
 *
 *   1. WHAT IT IS SHOWN. `BriefParts` is AC-11's list and nothing else, and
 *      `buildBriefUser` is the only assembly path, so there is no second door.
 *   2. HOW MUCH IT IS SHOWN. The complete payload — system + user + serialized
 *      schema — is counted through the `Tokenizer` port and asserted under
 *      budget before the call, with a fixed shedding order and a bounded
 *      protected floor that is checked before anything is spent.
 *   3. WHICH OF ITS ANSWERS SURVIVE. Every file, line, symbol and endpoint it
 *      names is checked against an allowlist and a per-file line index the
 *      server built BEFORE the call. Anything else drops the whole item.
 *   4. WHETHER THE RESULT IS STORED AT ALL. If the pull request moved to a new
 *      head while the call was in flight, the result is discarded.
 *
 * NO OUTBOUND FETCHES. This module reaches the network twice at most: the one
 * model call, and one GitHub `getIssue`. It adds no fetcher of any kind, so a
 * URL in the PR body, in the linked issue, or in the model's own output is
 * never opened — the same rule the intent service holds.
 */

/** Minimal structured-log sink, satisfied by Fastify's `req.log.info`. */
export type BriefLogger = (obj: Record<string, unknown>, msg: string) => void;

export interface GenerateOptions {
  /** Regenerate even when the stored brief matches the current head. */
  force?: boolean;
  log?: BriefLogger;
  logError?: BriefLogger;
}

/** Everything assembled for one generation, plus the ledger describing it. */
interface AssembledInputs {
  parts: BriefParts;
  ledger: RiskBriefInputEntry[];
  blast: BlastRadius | null;
}

/**
 * One input source's own result: the value, its ledger entries, and the
 * sentences the prompt should carry about it.
 *
 * Each loader returns its own slice rather than pushing into a shared array,
 * because the loaders run concurrently: pushing would order the ledger by
 * whichever promise happened to settle first, and a prompt whose bytes depend
 * on scheduling cannot be asserted byte-identical for identical inputs. The
 * caller merges them in a fixed order instead.
 */
interface Loaded<T> {
  value: T;
  ledger: RiskBriefInputEntry[];
  notes: string[];
}

/** An input the generator could not retrieve: ledgered AND told to the model. */
function missing<T>(value: T, section: string, reason: string, note: string): Loaded<T> {
  return { value, ledger: [{ section, status: 'unavailable', reason }], notes: [note] };
}

export class BriefService {
  private repo: BriefRepository;

  /**
   * Generations currently running, keyed by `${prId}:${headSha}` (AC-63).
   *
   * An INSTANCE field, which is why `routes.ts` constructs this service exactly
   * once at plugin registration: constructing it per request would give every
   * request its own empty map and delete the coalescing with no type error and
   * no failing typecheck.
   *
   * Consequences, stated because they are not obvious from the type:
   *   • a rejected generation rejects EVERY waiter with the identical error —
   *     they share one promise object;
   *   • the entry is deleted on both settle paths, so the NEXT request retries
   *     rather than inheriting a cached failure;
   *   • `force` joins the same key on purpose: a generation already in flight
   *     for the current head is by definition being computed from current
   *     state, so a regenerate arriving during it gets a fresh result.
   *
   * Scope is deliberately in-process. Durable cross-process coordination was
   * considered and rejected as disproportionate for a tool that runs one API
   * process on localhost.
   */
  private readonly inFlight = new Map<string, Promise<PrRiskBriefRecord>>();

  constructor(private container: Container) {
    this.repo = new BriefRepository(container.db);
  }

  /**
   * The stored brief for a PR, or `null` when none has ever been generated.
   *
   * ZERO LLM calls on every path, including the miss path: nothing in this
   * method reaches `container.llm`. A read failure propagates as an error and
   * never falls back to generating one — a read that failed is not evidence
   * that a paid call is wanted.
   */
  async get(workspaceId: string, prId: string): Promise<PrRiskBriefRecord | null> {
    const found = await this.repo.getPullWithRepo(workspaceId, prId);
    if (!found) throw new NotFoundError('Pull request not found');
    const row = await this.repo.getByPr(prId);
    return row ? toBriefDto(row) : null;
  }

  /** Generate (or return the cached) brief for a PR's current head. */
  async generate(
    workspaceId: string,
    prId: string,
    opts: GenerateOptions = {},
  ): Promise<PrRiskBriefRecord> {
    const found = await this.repo.getPullWithRepo(workspaceId, prId);
    if (!found) throw new NotFoundError('Pull request not found');
    const { pull, repo } = found;

    const stored = await this.repo.getByPr(prId);
    if (!opts.force && isFreshBrief(stored, pull.headSha)) {
      // Cache hit: no model call, and no single-flight entry to clean up.
      return toBriefDto(stored!);
    }

    const key = `${prId}:${pull.headSha}`;
    const running = this.inFlight.get(key);
    if (running) return running;

    const promise = this.runGeneration(workspaceId, pull, repo, opts).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  // =========================================================================
  // internals
  // =========================================================================

  private async runGeneration(
    workspaceId: string,
    pull: PullRow,
    repo: RepoRow,
    opts: GenerateOptions,
  ): Promise<PrRiskBriefRecord> {
    const count = (text: string) => this.container.tokenizer.count(text);

    const diff = await loadDiff(this.container, this.container.reviewRepo, workspaceId, pull, repo);
    const assembled = await this.assembleInputs(workspaceId, pull, repo, diff);

    // AC-60: bound every protected section BEFORE assembly, so the floor below
    // is finite for any pull request.
    const { bounded, ledger: boundLedger } = boundProtected(assembled.parts);
    const ledger = [...assembled.ledger, ...boundLedger];

    // Force the encoder to initialise (memoized, so the later call is free),
    // then refuse to gate on a heuristic. Order matters: `degraded` only tells
    // the truth once something has actually been counted, and this must sit
    // ahead of the floor check, whose own verdict would otherwise be computed
    // from the fallback numbers it exists to protect against.
    fixedOverheadTokens(count);
    assertEncoderIntact(this.container.tokenizer.degraded);

    // AC-61: refuse before ANYTHING is spent. This runs before provider
    // resolution and before any adapter is touched, so the zero-LLM-calls
    // guarantee is structural rather than a matter of ordering.
    assertFloorFits({ protectedUser: buildBriefUser(protectedOnly(bounded)), count });

    const shed = shedToBudget({
      sections: bounded,
      overheadTokens: fixedOverheadTokens(count),
      count,
    });
    ledger.push(...shed.ledger);

    const user = shed.text;
    const tokens = payloadTokens({ system: SYSTEM_PROMPT, user, count });
    assertWithinBudget(tokens);

    const choice = await resolveFeatureModel(this.container, workspaceId, 'risk_brief');
    const llm = await this.container.llm(choice.provider);

    let result;
    try {
      result = await llm.completeStructured({
        model: choice.model,
        schema: DraftedBrief,
        schemaName: BRIEF_SCHEMA_NAME,
        temperature: 0,
        maxTokens: BRIEF_MAX_COMPLETION_TOKENS,
        timeoutMs: BRIEF_TIMEOUT_MS,
        maxRetries: BRIEF_MAX_RETRIES,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: user },
        ],
      });
    } catch (err) {
      // The provider's own message is logged, never returned: it can carry a
      // verbatim response body, and a failed generation must not become a way
      // to read one back out through the API. A deliberate divergence from
      // `intent/service.ts`, which does interpolate it.
      opts.logError?.(
        {
          prId: pull.id,
          provider: choice.provider,
          model: choice.model,
          err: (err as Error).message,
        },
        'risk brief model call failed',
      );
      /*
       * Two failures, two different things to go and do.
       *
       * A completion cap exhausted before the answer began is OUR
       * configuration, not the provider's health — on a reasoning model the
       * reasoning tokens are drawn from `maxTokens` first, so the model returns
       * nothing and the repair loop gives up. Telling that reader to "check the
       * provider is reachable" sends them to the one place the fault is not.
       *
       * The branch reads the port's own diagnosis, which carries `finish_reason`
       * and the usage counters but no provider response body — so AC-31 holds
       * either way.
       */
      const capExhausted = (err as Error).message?.includes('hit the completion cap');
      throw new ExternalServiceError(
        capExhausted
          ? `Risk brief generation (${choice.provider}/${choice.model}) ran out of completion ` +
            `budget before the model produced an answer — on a reasoning model the reasoning ` +
            `tokens count against it too. Raise the completion cap, or pick a model that ` +
            `reasons less, in Settings → Models.`
          : `Risk brief generation (${choice.provider}/${choice.model}) failed. ` +
            `Check the provider is reachable and the model supports structured outputs ` +
            `in Settings → Models.`,
      );
    }
    // Nothing has been written at this point, so any previously stored brief is
    // untouched by the failure path above.

    const allowlist = buildAllowlist({
      changedFiles: diff.files.map((f) => f.path),
      blast: assembled.blast,
    });
    const validated = validateItems(
      { risks: result.data.risks, focus: result.data.review_focus },
      allowlist,
      buildValidLineIndex(diff),
    );

    const json: BriefPayload = {
      what: result.data.what.trim(),
      why: result.data.why.trim(),
      risk_level: result.data.risk_level,
      risks: validated.risks,
      review_focus: validated.focus,
      inputs: ledger,
      counts: validated.counts,
    };

    const values = {
      json,
      headSha: pull.headSha,
      provider: choice.provider,
      model: choice.model,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      costUsd: result.costUsd,
    };

    let outcome;
    try {
      outcome = await this.repo.upsertIfHeadUnchanged(pull.id, pull.headSha, values);
    } catch (err) {
      // The call succeeded and was paid for; the write did not. Nothing durable
      // records that the call happened, so the next request pays again — an
      // accepted limitation, not a guarantee. Log the whole result so it is at
      // least recoverable by hand.
      opts.logError?.(
        { prId: pull.id, ...values, err: (err as Error).message },
        'pr_brief write failed after a completed model call — the paid result follows so it is recoverable',
      );
      throw err;
    }

    if (outcome.written) {
      opts.log?.(
        {
          prId: pull.id,
          provider: choice.provider,
          model: choice.model,
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
          promptTokens: tokens,
          risksProposed: validated.counts.risks_proposed,
          risksKept: validated.counts.risks_kept,
          focusProposed: validated.counts.focus_proposed,
          focusKept: validated.counts.focus_kept,
        },
        'risk brief generated',
      );
      return toBriefDto(outcome.row);
    }

    // AC-64: the head moved while the call was in flight. The result describes
    // a commit that is no longer current, so it is discarded rather than
    // stored — storing it would overwrite a brief for the newer head.
    opts.log?.(
      { prId: pull.id, generatedFor: pull.headSha, currentHeadSha: outcome.currentHeadSha },
      'risk brief discarded: the pull request head moved during generation',
    );
    const current = await this.repo.getByPr(pull.id);
    if (current && outcome.currentHeadSha != null && current.headSha === outcome.currentHeadSha) {
      // Somebody has already briefed the new head; hand that back rather than
      // making this caller pay for a second call.
      return toBriefDto(current);
    }
    throw new AppError(
      'brief_stale_head',
      'The pull request moved to a new head while the brief was being generated; ' +
        'nothing was stored. Regenerate to brief the new head.',
      409,
    );
  }

  /**
   * Gather every allowed input and record a ledger entry for each one that is
   * unavailable or capped.
   *
   * The ledger is the feature's honesty guarantee: whatever the model then
   * says, the card and the log can state exactly what the generator did and
   * did not know. Every individual source failure is caught by its own loader
   * — a missing intent, an unindexed repo or an unreachable GitHub must
   * degrade the brief, not fail it.
   *
   * The four independent reads run concurrently, but their ledger entries and
   * their prompt sentences are merged in a FIXED order below, so the assembled
   * prompt does not depend on which promise settled first.
   */
  private async assembleInputs(
    workspaceId: string,
    pull: PullRow,
    repo: RepoRow,
    diff: UnifiedDiff,
  ): Promise<AssembledInputs> {
    const [intent, blast, riskAreas, contextPaths] = await Promise.all([
      this.loadIntent(workspaceId, pull.id),
      this.loadBlast(workspaceId, pull.id),
      this.loadRiskAreas(workspaceId, pull.id),
      this.loadContextPaths(workspaceId),
    ]);
    const issue = await this.loadIssue(pull, repo);
    const body = loadBody(pull);

    const loaded = [intent, body, issue, blast, riskAreas, contextPaths];
    const ledger = loaded.flatMap((l) => l.ledger);
    const notes = loaded.flatMap((l) => l.notes);

    // AC-62: `renderHunkHeaders` caps each file at MAX_HUNKS_PER_FILE and says
    // so INSIDE the prompt, but the prompt is not the ledger. A reader of
    // `inputs` must be able to see that a resolved input was reduced, without
    // having to read the prompt text to find out.
    const cappedFiles = diff.files.filter((f) => f.hunks.length > MAX_HUNKS_PER_FILE);
    if (cappedFiles.length > 0) {
      const dropped = cappedFiles.reduce((n, f) => n + f.hunks.length - MAX_HUNKS_PER_FILE, 0);
      ledger.push({
        section: 'hunk_headers',
        status: 'present',
        reason:
          `${dropped} hunk header(s) omitted across ${cappedFiles.length} file(s): each file ` +
          `is capped at ${MAX_HUNKS_PER_FILE} hunks, in the diff's own hunk order`,
      });
    }

    const parts: BriefParts = {
      title: pull.title,
      author: pull.author,
      branch: pull.branch,
      base: pull.base,
      additions: pull.additions,
      deletions: pull.deletions,
      filesCount: pull.filesCount,
      changedFiles: diff.files.map((f) => f.path),
      riskAreas: riskAreas.value,
      intent: intent.value,
      blastSummary: blast.value.blast?.summary ?? null,
      blastSymbols: blast.value.symbols,
      blastEndpoints: blast.value.endpoints,
      contextPaths: contextPaths.value,
      blastCallerFiles: blast.value.callerFiles,
      diff,
      hunkHeaderFiles: Math.min(MAX_FILES_IN_PROMPT, diff.files.length),
      issue: issue.value,
      body: body.value,
      notes,
    };

    return { parts, ledger, blast: blast.value.blast };
  }

  /** The stored L03 intent. NEVER triggers detection (AC-33). */
  private async loadIntent(
    workspaceId: string,
    prId: string,
  ): Promise<Loaded<BriefParts['intent']>> {
    try {
      const intent = await new IntentService(this.container).get(workspaceId, prId);
      if (!intent) {
        return missing(
          null,
          'stored_intent',
          'not_detected',
          'No intent has been detected for this pull request.',
        );
      }
      return {
        value: {
          intent: intent.intent,
          in_scope: intent.in_scope,
          out_of_scope: intent.out_of_scope,
        },
        ledger: [{ section: 'stored_intent', status: 'present', reason: null }],
        notes: [],
      };
    } catch (err) {
      return missing(
        null,
        'stored_intent',
        (err as Error).message,
        'The stored intent could not be read.',
      );
    }
  }

  /**
   * The L04 blast radius. A missing or failed index is a normal outcome, and it
   * produces an allowlist with no symbols and no endpoints (AC-34) — so a model
   * naming one has nothing to match against and the item drops.
   */
  private async loadBlast(workspaceId: string, prId: string): Promise<Loaded<BlastParts>> {
    const empty: BlastParts = { blast: null, symbols: [], callerFiles: [], endpoints: [] };
    try {
      const { blast } = await new BlastService(this.container).getForPull(workspaceId, prId);
      if (blast.index.status === 'missing' || blast.index.status === 'failed') {
        // The index's OWN reason, not a paraphrase of it.
        return missing(
          empty,
          'blast_radius',
          blast.index.reason ?? blast.index.status,
          `The repository index is ${blast.index.status}, so no blast radius is available.`,
        );
      }
      const callerFiles = new Set<string>();
      const endpoints = new Set<string>(blast.impacted_endpoints);
      for (const down of blast.downstream) {
        for (const caller of down.callers) callerFiles.add(caller.file);
        for (const affected of down.endpoints_affected) endpoints.add(affected.endpoint);
      }
      return {
        value: {
          blast,
          symbols: blast.changed_symbols.map((s) => `${s.name} (${s.kind}) in ${s.file}`),
          callerFiles: [...callerFiles],
          endpoints: [...endpoints],
        },
        ledger: [{ section: 'blast_radius', status: 'present', reason: null }],
        notes: [],
      };
    } catch (err) {
      return missing(
        empty,
        'blast_radius',
        (err as Error).message,
        'The blast radius could not be read.',
      );
    }
  }

  /** The deterministic risk-area scan. No model, no cost. */
  private async loadRiskAreas(
    workspaceId: string,
    prId: string,
  ): Promise<Loaded<BriefRiskAreaPart[]>> {
    try {
      const { risks } = await new RisksService(this.container).getForPull(workspaceId, prId);
      return {
        value: risks.map(renderRiskArea),
        ledger: [{ section: 'risk_scan', status: 'present', reason: null }],
        notes: [],
      };
    } catch (err) {
      return missing(
        [],
        'risk_scan',
        (err as Error).message,
        'The risk-area scan could not be run.',
      );
    }
  }

  /**
   * The repo-relative PATHS of every enabled agent's resolved context
   * documents — never a document body.
   *
   * Every enabled agent is resolved (there is deliberately no agent cap:
   * capping agents dropped resolved input silently, made the ledger false, and
   * capped the wrong thing — the fan-out is a handful of DB reads, the token
   * cost is in the paths). The union is deduplicated, sorted lexicographically
   * ascending, and only THEN truncated to `MAX_CONTEXT_PATHS`, with a ledger
   * entry naming the cap and the original count. Sorting before capping is what
   * makes the selection deterministic despite `AgentsRepository.listEnabled`
   * having no `ORDER BY`.
   */
  private async loadContextPaths(workspaceId: string): Promise<Loaded<string[]>> {
    try {
      const agents = await this.container.agentsRepo.listEnabled(workspaceId);
      const context = new ContextService(this.container);
      const resolved = await Promise.all(agents.map((a) => context.resolveForRun(a.id)));
      const all = [...new Set(resolved.flat())].sort();
      if (all.length <= MAX_CONTEXT_PATHS) {
        return {
          value: all,
          ledger: [{ section: 'context_paths', status: 'present', reason: null }],
          notes: [],
        };
      }
      return {
        value: all.slice(0, MAX_CONTEXT_PATHS),
        ledger: [
          {
            section: 'context_paths',
            status: 'present',
            reason:
              `${MAX_CONTEXT_PATHS} of ${all.length} resolved document paths included ` +
              `(lexicographic order)`,
          },
        ],
        notes: [],
      };
    } catch (err) {
      return missing(
        [],
        'context_paths',
        (err as Error).message,
        'The project-context document paths could not be resolved.',
      );
    }
  }

  /**
   * The linked issue, if the PR body names one.
   *
   * The `try` covers both the `ConfigError` a missing `GITHUB_TOKEN` throws out
   * of `container.github()` and the fetch itself — an unconfigured token is a
   * normal local state, not a reason to fail a generation. This is the module's
   * only outbound request besides the model call.
   */
  private async loadIssue(pull: PullRow, repo: RepoRow): Promise<Loaded<BriefParts['issue']>> {
    const issueNumber = extractIssueNumber(pull.body);
    if (issueNumber == null) {
      // AC-35 covers "names no issue" and "the fetch failed" alike: both are
      // inputs the brief did not get, and a ledger that records only the second
      // makes the first look like an input nobody looked for.
      return {
        value: null,
        ledger: [
          {
            section: 'linked_issue',
            status: 'unavailable',
            reason: 'the pull request body names no issue',
          },
        ],
        notes: [],
      };
    }
    try {
      const gh = await this.container.github();
      const fetched = await gh.getIssue({ owner: repo.owner, name: repo.name }, issueNumber);
      const raw = fetched.body ?? '';
      const body = raw.length > 0 ? raw.slice(0, MAX_ISSUE_CHARS) : null;
      return {
        value: { number: fetched.number, title: fetched.title, body },
        ledger: [
          {
            section: 'linked_issue',
            status: 'present',
            reason:
              body !== null && body.length < raw.length
                ? `body truncated to ${MAX_ISSUE_CHARS} of ${raw.length} characters`
                : null,
          },
        ],
        notes: [],
      };
    } catch (err) {
      return missing(
        null,
        'linked_issue',
        (err as Error).message,
        `Issue #${issueNumber} is referenced but could not be retrieved.`,
      );
    }
  }
}

/** The blast-derived sections, split by how the shedding order treats them. */
interface BlastParts {
  blast: BlastRadius | null;
  symbols: string[];
  callerFiles: string[];
  endpoints: string[];
}

/** The PR description, truncated to the same cap the intent classifier uses. */
function loadBody(pull: PullRow): Loaded<string | null> {
  const raw = (pull.body ?? '').trim();
  if (raw.length === 0) {
    return missing(null, 'pr_body', 'empty_body', 'The pull request has no description.');
  }
  const body = raw.slice(0, MAX_BODY_CHARS);
  return {
    value: body,
    ledger: [
      {
        section: 'pr_body',
        status: 'present',
        reason:
          body.length < raw.length
            ? `truncated to ${MAX_BODY_CHARS} of ${raw.length} characters`
            : null,
      },
    ],
    notes: [],
  };
}


/** One risk-scan entry as a single bounded line: title, why, and where. */
function renderRiskArea(risk: Risk): BriefRiskAreaPart {
  const where = risk.file_refs.length > 0 ? ` — ${risk.file_refs.join(', ')}` : '';
  return { severity: risk.severity, text: `${risk.title}: ${risk.explanation}${where}` };
}
