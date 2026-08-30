import type {
  IntentConfidence,
  IntentSource,
  PrIntentRecord,
  UnifiedDiff,
} from '@devdigest/shared';
import type { IntentForPrompt } from '@devdigest/reviewer-core';
import type { IntentSourceRow } from '../../db/schema/reviews.js';
import type { PrIntentRow } from './repository.js';
import {
  MAX_FILES_IN_PROMPT,
  MAX_HUNKS_PER_FILE,
  MAX_PATH_DEPTH,
  MAX_PATH_LENGTH,
  MAX_SPEC_CANDIDATES,
  MIN_BODY_CHARS,
  SPEC_EXTENSIONS,
} from './constants.js';

/**
 * Pure helpers for the intent classifier: what the model is allowed to see,
 * which repo paths may be read, and how confident the result is allowed to be.
 *
 * No I/O and no container, so each rule below is unit-testable on its own —
 * which matters, because two of them are security boundaries:
 *   • `renderHunkHeaders` is the reason no diff BODY ever reaches the cheap
 *     classifier (only file names and `@@` headers, built from the parsed hunk
 *     structs — never from `diff.raw`).
 *   • `safeRepoRelativePath` is the containment check `GitClient.readFile` does
 *     NOT have (`adapters/git/simple-git.ts` joins the path onto the clone dir
 *     with no validation, so `../../etc/passwd` escapes the clone).
 */

// ---------------------------------------------------------------- file list

/**
 * Render the changed-file list with hunk headers ONLY.
 *
 * Output shape:
 *   src/config.ts (4 added, 0 removed)
 *     @@ -10,3 +10,4 @@
 *
 * Built exclusively from `diff.files[].hunks[]` — the parsed coordinates — so
 * there is no code path by which added/removed source lines can leak into the
 * classifier prompt. Deliberately spells out "added/removed" instead of `+4/-0`
 * so that NO line of this output other than a hunk header carries diff-marker
 * characters at all.
 */
export function renderHunkHeaders(diff: UnifiedDiff, maxFiles = MAX_FILES_IN_PROMPT): string {
  const lines: string[] = [];
  const files = diff.files.slice(0, maxFiles);
  for (const f of files) {
    lines.push(`${f.path} (${f.additions} added, ${f.deletions} removed)`);
    for (const h of f.hunks.slice(0, MAX_HUNKS_PER_FILE)) {
      lines.push(`  @@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
    }
    const hidden = f.hunks.length - MAX_HUNKS_PER_FILE;
    if (hidden > 0) lines.push(`  (${hidden} further hunk(s) omitted)`);
  }
  const more = diff.files.length - files.length;
  if (more > 0) lines.push(`(${more} further changed file(s) omitted)`);
  return lines.join('\n');
}

// ------------------------------------------------------------ path handling

/** Doc-ish paths mentioned in a PR body: `docs/plan.md`, `(spec/api.rst)`, … */
const SPEC_CANDIDATE_RE = new RegExp(
  `(?:^|[\\s(\`'"\\[<>])([A-Za-z0-9._\\-/]+(?:${SPEC_EXTENSIONS.map((e) => e.slice(1)).join('|')}))\\b`,
  'gi',
);

/**
 * Candidate spec/plan paths mentioned in a PR description.
 *
 * Returns RAW candidates — deduped, capped, and restricted to the doc
 * extensions, but NOT safety-checked. `safeRepoRelativePath` is applied by the
 * caller immediately before each read, so the gate sits at the dangerous
 * operation rather than at a helper someone could later bypass. A candidate
 * that fails the gate is still reported to the user as a `missing` source.
 *
 * URLs do not produce candidates: `https://host/docs/plan.md` contains `:` and
 * `//`, neither of which can start or sit inside the allowed character run.
 */
export function extractSpecPaths(body: string | null | undefined): string[] {
  if (!body) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(SPEC_CANDIDATE_RE)) {
    const raw = m[1];
    if (!raw) continue;
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
    if (out.length >= MAX_SPEC_CANDIDATES) break;
  }
  return out;
}

/**
 * The path-traversal gate. Returns the normalized repo-relative path, or `null`
 * when the input must not be handed to `GitClient.readFile`.
 *
 * Rejects: absolute paths, `~`, any `.`/`..` segment, backslashes, null bytes,
 * anything outside `[A-Za-z0-9._-/]`, depth > 6, length > 200, and any
 * extension that is not an allowlisted doc extension. Allowlist-shaped on
 * purpose — a denylist of traversal spellings is a losing game.
 */
export function safeRepoRelativePath(input: string): string | null {
  if (typeof input !== 'string') return null;
  let p = input.trim();
  if (p.length === 0 || p.length > MAX_PATH_LENGTH) return null;
  if (p.includes('\0') || p.includes('\\')) return null;
  if (p.startsWith('~') || p.startsWith('/')) return null;
  while (p.startsWith('./')) p = p.slice(2);
  // Single allowlisted character class: rules out `:`, `~`, spaces, control
  // characters, URL-encoded traversal (`%2e%2e`, since `%` is not allowed), …
  if (!/^[A-Za-z0-9._\-/]+$/.test(p)) return null;

  const segments = p.split('/');
  if (segments.length > MAX_PATH_DEPTH) return null;
  for (const segment of segments) {
    // Empty segment = `//` or a trailing slash; `.`/`..` = traversal.
    if (segment.length === 0 || segment === '.' || segment === '..') return null;
  }

  const dot = p.lastIndexOf('.');
  const ext = dot === -1 ? '' : p.slice(dot).toLowerCase();
  if (!SPEC_EXTENSIONS.includes(ext)) return null;
  return p;
}

/**
 * External links in a PR body. Recorded as sources; NEVER fetched (see §SSRF).
 *
 * Trailing sentence punctuation is stripped: `…/x.` at the end of a sentence is
 * the writer's full stop, not part of the link. These strings are shown to the
 * user as "not retrieved" chips, so a stray period reads as a broken link.
 */
export function extractUrls(body: string | null | undefined): string[] {
  if (!body) return [];
  const seen = new Set<string>();
  for (const m of body.matchAll(/https?:\/\/[^\s)>\]"'`]+/gi)) {
    const url = m[0]?.replace(/[.,;:!?]+$/, '');
    if (url) seen.add(url);
  }
  return [...seen];
}

/** First `#123` issue reference in a PR body (`Closes #471`), if any. */
export function extractIssueNumber(body: string | null | undefined): number | null {
  if (!body) return null;
  const m = body.match(/(?:^|[\s(\[])#(\d{1,7})\b/);
  if (!m?.[1]) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** True when a PR description is substantial enough to corroborate an intent. */
export function isSubstantialBody(body: string | null | undefined): boolean {
  return (body ?? '').trim().length >= MIN_BODY_CHARS;
}

// ----------------------------------------------------------- confidence

export interface ComputedConfidence {
  /** 0–1, rounded to 2dp. */
  confidence: number;
  level: IntentConfidence;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Confidence is computed FROM THE SOURCES THAT WERE ACTUALLY ASSEMBLED; the
 * model's self-reported number can only ever LOWER it.
 *
 * Self-reported LLM confidence is badly calibrated (GPT-4 scores ~62.7% AUROC
 * on failure prediction — barely above chance) and a model that has just
 * committed to an answer justifies rather than critiques it. So the ceiling is
 * ours and deterministic:
 *
 *   1.0 high   — substantial body AND a used linked_issue or spec_file
 *   0.7 medium — substantial body, nothing corroborating
 *   0.4 low    — no usable body: title + file names + hunk headers only
 *
 * Any `missing` source other than a `url` caps the ceiling at medium (a url is
 * always missing by design, so counting it would pin every PR with a link to
 * medium). Final = min(clamp01(model ?? 1), ceiling).
 */
export function computeConfidence(
  sources: IntentSource[],
  modelReported?: number | null,
): ComputedConfidence {
  const used = (kind: IntentSource['kind']) =>
    sources.some((s) => s.kind === kind && s.status === 'used');

  const bodyUsed = used('body');
  const corroborated = used('linked_issue') || used('spec_file');
  let ceiling = bodyUsed ? (corroborated ? 1 : 0.7) : 0.4;

  const missingNonUrl = sources.some((s) => s.status === 'missing' && s.kind !== 'url');
  if (missingNonUrl) ceiling = Math.min(ceiling, 0.7);

  const reported =
    typeof modelReported === 'number' && Number.isFinite(modelReported)
      ? clamp01(modelReported)
      : 1;

  const confidence = round2(Math.min(reported, ceiling));
  return { confidence, level: confidenceLevel(confidence) };
}

/** Bucket a 0–1 confidence. `< 0.5` low, `< 0.85` medium, else high. */
export function confidenceLevel(confidence: number): IntentConfidence {
  if (confidence < 0.5) return 'low';
  if (confidence < 0.85) return 'medium';
  return 'high';
}

// ------------------------------------------------------------- row mapping

/** `head_sha IS NULL` = a pre-migration row → always stale, so it re-detects. */
export function isFresh(row: PrIntentRow | undefined, headSha: string): boolean {
  return row?.headSha != null && row.headSha === headSha;
}

/**
 * `pr_intent.sources` is persisted through a structural mirror
 * (`IntentSourceRow`) because the schema layer does not import the contracts.
 * Re-widen it here; unknown kinds/statuses cannot occur since this repository
 * is the only writer.
 */
function sourcesFromRow(rows: IntentSourceRow[] | null): IntentSource[] {
  return (rows ?? []).map((s) => ({
    kind: s.kind as IntentSource['kind'],
    ref: s.ref ?? null,
    status: s.status,
    reason: s.reason ?? null,
  }));
}

export function toIntentDto(row: PrIntentRow): PrIntentRecord {
  return {
    pr_id: row.prId,
    intent: row.intent,
    in_scope: row.inScope ?? [],
    out_of_scope: row.outOfScope ?? [],
    confidence: row.confidence,
    confidence_level: row.confidenceLevel,
    sources: sourcesFromRow(row.sources),
    head_sha: row.headSha,
    generated_at: row.generatedAt.toISOString(),
    provider: row.provider,
    model: row.model,
    cost_usd: row.costUsd,
  };
}

/**
 * The subset reviewer-core needs. The SAME object feeds `## Intent` and
 * `applyScopeFilter`, so what the prompt says and what the filter does can
 * never disagree.
 */
export function toPromptIntent(row: PrIntentRow): IntentForPrompt {
  return {
    intent: row.intent,
    in_scope: row.inScope ?? [],
    out_of_scope: row.outOfScope ?? [],
    confidence_level: row.confidenceLevel,
  };
}

// ------------------------------------------------------------- log helpers

/**
 * `sources used: title, body, linked_issue#42 · missing: url(external_fetch_disabled)`
 *
 * Only source KINDS and short refs (issue number / repo path) — never the
 * fetched content, and never a secret.
 */
export function describeSources(sources: IntentSource[]): string {
  const label = (s: IntentSource) => `${s.kind}${s.ref ? `:${s.ref}` : ''}`;
  const used = sources.filter((s) => s.status === 'used').map(label);
  const missing = sources
    .filter((s) => s.status === 'missing')
    .map((s) => `${label(s)}(${s.reason ?? 'unavailable'})`);
  const parts = [`sources used: ${used.length > 0 ? used.join(', ') : 'none'}`];
  if (missing.length > 0) parts.push(`missing: ${missing.join(', ')}`);
  return parts.join(' · ');
}

/** `sources=title,body; missing=url; conf=medium(0.7); ~842 tok` — trace meta. */
export function traceMeta(row: PrIntentRow): string {
  const sources = sourcesFromRow(row.sources);
  const used = sources.filter((s) => s.status === 'used').map((s) => s.kind);
  const missing = sources.filter((s) => s.status === 'missing').map((s) => s.kind);
  const parts = [`sources=${used.join(',') || 'none'}`];
  if (missing.length > 0) parts.push(`missing=${[...new Set(missing)].join(',')}`);
  parts.push(`conf=${row.confidenceLevel ?? 'unknown'}(${row.confidence ?? 0})`);
  parts.push(`~${(row.tokensIn ?? 0) + (row.tokensOut ?? 0)} tok`);
  return parts.join('; ');
}
