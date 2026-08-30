import type {
  BlastRadius,
  PrRiskBriefRecord,
  RiskBriefCounts,
  RiskBriefFocusItem,
  RiskBriefInputEntry,
  RiskBriefReference,
  RiskBriefRiskItem,
  UnifiedDiff,
} from '@devdigest/shared';
import { MAX_FILES_IN_PROMPT } from '../intent/constants.js';
import type { PrBriefRow } from './repository.js';
import {
  BRIEF_TOKEN_BUDGET,
  MAX_BLAST_ENDPOINTS,
  MAX_BLAST_SYMBOLS,
  MAX_ENTITY_CHARS,
  MAX_INTENT_CHARS,
  MAX_PATH_CHARS,
  MAX_REF_CHARS,
  MAX_RISK_AREAS,
  MAX_RISK_AREA_CHARS,
  MAX_SCOPE_ITEMS,
  MAX_SCOPE_ITEM_CHARS,
  MAX_TITLE_CHARS,
} from './constants.js';
import {
  buildBriefUser,
  type BriefParts,
  type DraftedFocusItem,
  type DraftedRiskItem,
} from './prompt.js';

/**
 * Pure logic for the Why + Risk brief: what the model may name, which lines
 * exist, which of its answers survive, and what gets cut when the input does
 * not fit.
 *
 * Zero I/O and no `Container`, so every rule below is unit-testable on its own
 * — which matters, because two of them are the feature's integrity gate:
 * `buildAllowlist` + `buildValidLineIndex` decide what the model is allowed to
 * have named, and `validateItems` drops everything that fails. That gate is
 * not optional and has no bypass: this feature produces no `Finding[]`, so
 * `groundFindings()` is not on its path, and these three functions are the
 * equivalent invariant.
 */

// ------------------------------------------------------------- the allowlist

/** Exact-match sets of every entity the model is permitted to name. */
export interface BriefAllowlist {
  files: Set<string>;
  symbols: Set<string>;
  endpoints: Set<string>;
}

/**
 * Build the allowlist from the PR's changed paths and the blast radius.
 *
 * Entries are OPAQUE STRINGS compared by exact equality. They are never
 * patterns, never globs, never filesystem operands, and they are never
 * normalised beyond the surrounding whitespace `validateItems` trims off a
 * model answer. That is a deliberate trade, and these are its consequences:
 *
 *   • a case change (`SRC/App.ts` for `src/app.ts`), a `./` prefix, a `..`
 *     component, a doubled `//` or a back-slash separator all fail to match,
 *     so the item carrying them is dropped rather than silently repaired;
 *   • a RENAMED file contributes its new-side path only, so a reference to the
 *     old path drops;
 *   • a DELETED file's path IS in the allowlist (it is still in `diff.files`),
 *     so a file-only reference to it survives — but any `line` on it fails,
 *     because its new-side line set is empty;
 *   • a blast CALLER file is in the file allowlist but has no line-index
 *     entry, because the line index is built from the diff. A file-only
 *     reference to a caller survives; a `line` on one does not.
 *
 * Built from ALL of the PR's changed file paths, while the prompt shows at
 * most `MAX_FILES_IN_PROMPT` of them (AC-23 says "the pull request's changed
 * file paths", unqualified).
 */
export function buildAllowlist(input: {
  changedFiles: string[];
  blast: BlastRadius | null;
}): BriefAllowlist {
  const files = new Set<string>();
  const symbols = new Set<string>();
  const endpoints = new Set<string>();

  for (const path of input.changedFiles) if (path) files.add(path);

  const blast = input.blast;
  if (blast) {
    for (const symbol of blast.changed_symbols) if (symbol.name) symbols.add(symbol.name);
    for (const endpoint of blast.impacted_endpoints) if (endpoint) endpoints.add(endpoint);
    for (const down of blast.downstream) {
      for (const caller of down.callers) if (caller.file) files.add(caller.file);
      for (const affected of down.endpoints_affected) {
        if (affected.endpoint) endpoints.add(affected.endpoint);
      }
    }
  }

  return { files, symbols, endpoints };
}

/**
 * `file → set of valid new-side line numbers`.
 *
 * MIRRORED, not imported, from `buildLineIndex` (`reviewer-core/src/
 * grounding.ts:24-38`) — that symbol is not re-exported from reviewer-core's
 * barrel (`reviewer-core/src/index.ts` exports `groundFindings`,
 * `groundingSummary` and `GroundingResult` from that file, not
 * `buildLineIndex`), and this feature does not edit reviewer-core.
 *
 * The copy is exact, INCLUDING the fallback at `grounding.ts:29-33`: when a
 * hunk carries no `newLineNumbers` the hunk's declared new range
 * `[newStart, newStart + max(newLines, 1))` is used instead. Drop that
 * fallback and every diff parsed without per-line numbers silently grounds
 * nothing. Keep this function and its source in step.
 */
export function buildValidLineIndex(diff: UnifiedDiff): Map<string, Set<number>> {
  const idx = new Map<string, Set<number>>();
  for (const f of diff.files) {
    const set = new Set<number>();
    for (const h of f.hunks) {
      if (h.newLineNumbers && h.newLineNumbers.length > 0) {
        for (const n of h.newLineNumbers) set.add(n);
      } else {
        // fall back to the hunk's declared new range
        for (let n = h.newStart; n < h.newStart + Math.max(h.newLines, 1); n++) set.add(n);
      }
    }
    idx.set(f.path, set);
  }
  return idx;
}

// -------------------------------------------------------- reference validity

/** A string field counts as CARRIED only when it survives `trim()` non-empty. */
function carried(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Validate one drafted reference. Returns the normalised reference to store,
 * or `null` when the item carrying it must be dropped.
 *
 * A valid field NEVER rescues an invalid one (AC-20b): every carried field is
 * checked and any single failure drops the whole item. Trimming surrounding
 * whitespace is the only normalisation applied — a transport artefact, not a
 * path component. Nothing else about the value is rewritten.
 */
function validateReference(
  ref: DraftedRiskItem['reference'],
  allowlist: BriefAllowlist,
  lineIndex: Map<string, Set<number>>,
): RiskBriefReference | null {
  const file = carried(ref.file);
  const symbol = carried(ref.symbol);
  const endpoint = carried(ref.endpoint);
  const line = typeof ref.line === 'number' ? ref.line : null;

  // AC-20: a reference carrying nothing — `{}`, `{ file: null }`, `{ file: '' }`.
  if (file === null && symbol === null && endpoint === null && line === null) return null;

  if (line !== null) {
    // AC-20a: a line without a file can be neither validated nor rendered.
    if (file === null) return null;
    // A line must be a positive integer on the new side.
    if (!Number.isInteger(line) || line <= 0) return null;
  }

  // AC-25 / AC-26.
  if (file !== null) {
    if (!allowlist.files.has(file)) return null;
    if (line !== null && !(lineIndex.get(file)?.has(line) ?? false)) return null;
  }

  // AC-27.
  if (symbol !== null && !allowlist.symbols.has(symbol)) return null;
  if (endpoint !== null && !allowlist.endpoints.has(endpoint)) return null;

  return {
    file,
    line,
    symbol,
    endpoint,
  };
}

export interface ValidatedItems {
  risks: RiskBriefRiskItem[];
  focus: RiskBriefFocusItem[];
  counts: RiskBriefCounts;
}

/**
 * Drop every risk and review-focus item whose reference does not survive.
 *
 * The whole ITEM goes, not just the offending field: a risk whose location is
 * invented is a risk about a place that may not exist, and keeping its prose
 * while quietly deleting its pointer is worse than not showing it.
 *
 * A reference with no `file` but a valid `symbol` or `endpoint` SURVIVES — the
 * card renders it as non-navigating text. `what`, `why` and `risk_level` are
 * never passed in: they carry no reference and are not subject to this gate
 * (AC-30). An all-dropped result is a legitimate outcome and is still stored,
 * with empty arrays and populated counts (AC-32) — which is why the counts
 * exist at all: "the model invented every reference" and "this PR is genuinely
 * low-risk" must not present identically.
 */
export function validateItems(
  drafted: { risks: DraftedRiskItem[]; focus: DraftedFocusItem[] },
  allowlist: BriefAllowlist,
  lineIndex: Map<string, Set<number>>,
): ValidatedItems {
  const risks: RiskBriefRiskItem[] = [];
  for (const item of drafted.risks) {
    const reference = validateReference(item.reference, allowlist, lineIndex);
    if (!reference) continue;
    risks.push({ severity: item.severity, summary: item.summary.trim(), reference });
  }

  const focus: RiskBriefFocusItem[] = [];
  for (const item of drafted.focus) {
    const reference = validateReference(item.reference, allowlist, lineIndex);
    if (!reference) continue;
    focus.push({ summary: item.summary.trim(), reference });
  }

  return {
    risks,
    focus,
    counts: {
      risks_proposed: drafted.risks.length,
      risks_kept: risks.length,
      focus_proposed: drafted.focus.length,
      focus_kept: focus.length,
    },
  };
}

// --------------------------------------------------------- bounding the floor

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

export interface BoundedParts {
  bounded: BriefParts;
  ledger: RiskBriefInputEntry[];
}

/**
 * Apply every AC-60 bound to the sections the shedding order PROTECTS, before
 * assembly, so the protected floor is finite for any pull request.
 *
 * Every section that is actually reduced produces one ledger entry naming the
 * bound and the original size (AC-62). A bounded input stays `present` with a
 * `reason` rather than becoming a fourth status — a reduced input is not a
 * removed one, and reporting it as removed would make the ledger lie in the
 * other direction.
 */
export function boundProtected(parts: BriefParts): BoundedParts {
  const ledger: RiskBriefInputEntry[] = [];
  const note = (section: string, reason: string) =>
    ledger.push({ section, status: 'present', reason });

  const title = clip(parts.title, MAX_TITLE_CHARS);
  if (title.length < parts.title.length) {
    note('pr_title', `truncated to ${MAX_TITLE_CHARS} of ${parts.title.length} characters`);
  }

  const author = clip(parts.author, MAX_REF_CHARS);
  const branch = clip(parts.branch, MAX_REF_CHARS);
  const base = clip(parts.base, MAX_REF_CHARS);
  if (
    author.length < parts.author.length ||
    branch.length < parts.branch.length ||
    base.length < parts.base.length
  ) {
    note('pr_refs', `author, branch and base truncated to ${MAX_REF_CHARS} characters each`);
  }

  const changedFiles = parts.changedFiles
    .slice(0, MAX_FILES_IN_PROMPT)
    .map((p) => clip(p, MAX_PATH_CHARS));
  if (parts.changedFiles.length > MAX_FILES_IN_PROMPT) {
    note(
      'changed_files',
      `${MAX_FILES_IN_PROMPT} of ${parts.changedFiles.length} changed file paths included ` +
        `(the pull request's own file order)`,
    );
  }

  const riskAreas = parts.riskAreas
    .slice(0, MAX_RISK_AREAS)
    .map((r) => ({ severity: r.severity, text: clip(r.text, MAX_RISK_AREA_CHARS) }));
  if (parts.riskAreas.length > MAX_RISK_AREAS) {
    note(
      'risk_scan',
      `${MAX_RISK_AREAS} of ${parts.riskAreas.length} risk-area entries included ` +
        `(scan order, highest severity first)`,
    );
  }

  let intent = parts.intent;
  if (intent) {
    const clipped = {
      intent: clip(intent.intent, MAX_INTENT_CHARS),
      in_scope: intent.in_scope.slice(0, MAX_SCOPE_ITEMS).map((s) => clip(s, MAX_SCOPE_ITEM_CHARS)),
      out_of_scope: intent.out_of_scope
        .slice(0, MAX_SCOPE_ITEMS)
        .map((s) => clip(s, MAX_SCOPE_ITEM_CHARS)),
    };
    if (
      clipped.intent.length < intent.intent.length ||
      intent.in_scope.length > MAX_SCOPE_ITEMS ||
      intent.out_of_scope.length > MAX_SCOPE_ITEMS
    ) {
      note(
        'stored_intent',
        `intent truncated to ${MAX_INTENT_CHARS} characters and each scope list to ` +
          `${MAX_SCOPE_ITEMS} entries of ${MAX_SCOPE_ITEM_CHARS} characters`,
      );
    }
    intent = clipped;
  }

  const blastSummary =
    parts.blastSummary === null ? null : clip(parts.blastSummary, MAX_ENTITY_CHARS);
  const blastSymbols = parts.blastSymbols
    .slice(0, MAX_BLAST_SYMBOLS)
    .map((s) => clip(s, MAX_ENTITY_CHARS));
  const blastEndpoints = parts.blastEndpoints
    .slice(0, MAX_BLAST_ENDPOINTS)
    .map((s) => clip(s, MAX_ENTITY_CHARS));
  if (
    parts.blastSymbols.length > MAX_BLAST_SYMBOLS ||
    parts.blastEndpoints.length > MAX_BLAST_ENDPOINTS
  ) {
    note(
      'blast_radius',
      `${blastSymbols.length} of ${parts.blastSymbols.length} changed symbols and ` +
        `${blastEndpoints.length} of ${parts.blastEndpoints.length} impacted endpoints included ` +
        `(blast-radius order)`,
    );
  }

  // Caller files are SHEDDABLE, so they are not part of the floor — but each
  // path is still clipped, so one absurd path cannot dominate the message the
  // budget is measured over before shedding starts.
  const blastCallerFiles = parts.blastCallerFiles.map((p) => clip(p, MAX_PATH_CHARS));
  const contextPaths = parts.contextPaths.map((p) => clip(p, MAX_PATH_CHARS));

  return {
    bounded: {
      ...parts,
      title,
      author,
      branch,
      base,
      changedFiles,
      riskAreas,
      intent,
      blastSummary,
      blastSymbols,
      blastEndpoints,
      blastCallerFiles,
      contextPaths,
    },
    ledger,
  };
}

/**
 * The protected floor: the same parts with every sheddable section already
 * gone. What `assertFloorFits` measures, and what a fully shed prompt reduces
 * to — so if this fits, the shedding loop terminates.
 */
export function protectedOnly(parts: BriefParts): BriefParts {
  return {
    ...parts,
    contextPaths: [],
    blastCallerFiles: [],
    hunkHeaderFiles: null,
    issue: parts.issue ? { ...parts.issue, body: null } : null,
    body: null,
  };
}

// ------------------------------------------------------------------ shedding

export interface ShedResult {
  /** The assembled user message that fits — or the smallest one reachable. */
  text: string;
  /** One entry per section actually removed, in the order removed. */
  ledger: RiskBriefInputEntry[];
}

/**
 * Remove sheddable sections, in AC-14's fixed order, until the COMPLETE model
 * input fits the budget.
 *
 * `overheadTokens` is the fixed system-message + serialized-schema + envelope
 * cost from `budget.ts`. Passing only the user message here is the mistake
 * this parameter exists to prevent: the budget covers everything sent, so the
 * loop has to measure everything sent.
 *
 * Each removal appends its own sentence to `sections.notes` BEFORE the recount,
 * so the AC-16 statement telling the model what was removed is itself inside
 * the number AC-13 constrains. Recounting after every step and stopping the
 * moment it fits is what keeps the model's context as full as the budget
 * allows rather than cutting to the floor.
 *
 * The order is total and deterministic:
 *   1. project-context document paths
 *   2. blast caller lists
 *   3. hunk headers — `n` starts at `min(80, diff.files.length)` and HALVES
 *      (`floor(n / 2)`) each step until it reaches 0, at which point the
 *      headers go entirely and only the protected changed-file path list
 *      remains. `renderHunkHeaders` always takes the first `n` files in
 *      `diff.files` order, so the same inputs give a byte-identical prompt.
 *   4. the linked issue's body (its number and title are protected)
 *   5. the PR body
 *
 * The protected set is never touched: title, author, branch, base, the change
 * counts, the changed file paths, the risk-area scan, the stored intent, and
 * the blast summary, symbols and impacted endpoints.
 */
export function shedToBudget(input: {
  sections: BriefParts;
  overheadTokens: number;
  count: (text: string) => number;
}): ShedResult {
  const { overheadTokens, count } = input;
  let parts: BriefParts = { ...input.sections, notes: [...input.sections.notes] };
  const ledger: RiskBriefInputEntry[] = [];

  let text = buildBriefUser(parts);
  const fits = () => overheadTokens + count(text) <= BRIEF_TOKEN_BUDGET;
  if (fits()) return { text, ledger };

  /** Remove one section, tell the model about it, and re-assemble. */
  const remove = (section: string, reason: string, mutate: (p: BriefParts) => BriefParts) => {
    ledger.push({ section, status: 'removed', reason });
    parts = { ...mutate(parts), notes: [...parts.notes, reason] };
    text = buildBriefUser(parts);
  };

  // 1 — project-context document paths.
  if (parts.contextPaths.length > 0) {
    remove(
      'context_paths',
      'The project-context document paths were removed to fit the input budget.',
      (p) => ({ ...p, contextPaths: [] }),
    );
    if (fits()) return { text, ledger };
  }

  // 2 — blast caller lists.
  if (parts.blastCallerFiles.length > 0) {
    remove(
      'blast_callers',
      'The blast radius caller file list was removed to fit the input budget.',
      (p) => ({ ...p, blastCallerFiles: [] }),
    );
    if (fits()) return { text, ledger };
  }

  // 3 — hunk headers: progressively fewer files, then not at all.
  //
  // Each halving REPLACES the previous stage's note rather than appending to
  // it, so the message never accumulates one sentence per halving — and the
  // note is in place before the recount, so what is measured is what is sent.
  if (parts.hunkHeaderFiles !== null) {
    const notesBeforeHunks = parts.notes;
    let n = parts.hunkHeaderFiles;
    while (n > 0) {
      n = Math.floor(n / 2);
      if (n === 0) break;
      const reason =
        `The @@ hunk headers were reduced to the first ${n} changed file(s) to fit the ` +
        `input budget; every changed file path remains.`;
      parts = { ...parts, hunkHeaderFiles: n, notes: [...notesBeforeHunks, reason] };
      text = buildBriefUser(parts);
      if (fits()) {
        ledger.push({ section: 'hunk_headers', status: 'removed', reason });
        return { text, ledger };
      }
    }
    parts = { ...parts, notes: notesBeforeHunks };
    remove(
      'hunk_headers',
      'The @@ hunk headers were removed to fit the input budget; the changed file paths remain.',
      (p) => ({ ...p, hunkHeaderFiles: null }),
    );
    if (fits()) return { text, ledger };
  }

  // 4 — the linked issue's body.
  if (parts.issue?.body) {
    remove(
      'linked_issue_body',
      'The linked issue body was removed to fit the input budget; its number and title remain.',
      (p) => ({ ...p, issue: p.issue ? { ...p.issue, body: null } : null }),
    );
    if (fits()) return { text, ledger };
  }

  // 5 — the PR body.
  if (parts.body) {
    remove('pr_body', 'The PR description was removed to fit the input budget.', (p) => ({
      ...p,
      body: null,
    }));
  }

  // Whatever is left IS the protected floor. `assertFloorFits` ran before any
  // adapter was touched, so reaching here without fitting is an invariant
  // break, which `assertWithinBudget` turns into a loud failure rather than an
  // over-budget call.
  return { text, ledger };
}

// ---------------------------------------------------------------- row mapping

/**
 * `pr_brief` row → the stored contract.
 *
 * `head_sha`, `provider`, `model`, `tokens_in`, `tokens_out` and `cost_usd`
 * are all required MEMBERS of `PrRiskBriefRecord` (nullable in value), so the
 * route response carries the same provenance the row does. Omitting the token
 * counts here would make AC-7 true of the database and false of the API.
 */
export function toBriefDto(row: PrBriefRow): PrRiskBriefRecord {
  return {
    pr_id: row.prId,
    what: row.json.what,
    why: row.json.why,
    risk_level: row.json.risk_level,
    risks: row.json.risks.map((r) => ({
      severity: r.severity,
      summary: r.summary,
      reference: { ...r.reference },
    })),
    review_focus: row.json.review_focus.map((f) => ({
      summary: f.summary,
      reference: { ...f.reference },
    })),
    inputs: row.json.inputs.map((i) => ({
      section: i.section,
      status: i.status,
      reason: i.reason ?? null,
    })),
    counts: { ...row.json.counts },
    head_sha: row.headSha,
    generated_at: row.generatedAt.toISOString(),
    provider: row.provider,
    model: row.model,
    tokens_in: row.tokensIn,
    tokens_out: row.tokensOut,
    cost_usd: row.costUsd,
  };
}

/** `head_sha IS NULL` = a pre-migration row → always stale, so it regenerates. */
export function isFreshBrief(row: PrBriefRow | undefined, headSha: string): boolean {
  return row?.headSha != null && row.headSha === headSha;
}
