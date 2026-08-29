import type { Finding, Severity } from '@devdigest/shared';
import type { IntentForPrompt } from './prompt.js';

/**
 * Scope filter — the second "model proposes, code decides" gate, sitting
 * immediately after `groundFindings` and before scoring.
 *
 * It DEMOTES findings the PR author's derived intent puts out of scope. It
 * never deletes one: `applyScopeFilter(xs, …).findings.length === xs.length`
 * always holds, so a demotion can hide a finding's urgency but never the
 * finding itself.
 *
 * It lives in reviewer-core, not the server, for the same reason
 * `formatSkillBlocks` does (see `INSIGHTS.md`): the CI runner calls
 * `reviewPullRequest` too, and a server-side filter would leave CI silently
 * applying un-softened severities.
 *
 * The whole thing is pure code on purpose. Published prompt-injection defenses
 * that depend on model behaviour were broken at >90% attack success against
 * adaptive attackers ("Attacker Moves Second", Oct 2025); a defense an attacker
 * can talk past is not a defense. So the escape hatch below is a hard
 * severity/category/kind predicate — no model call, no heuristic, no config.
 */

/** Categories that can never be demoted. `bug` is this schema's "correctness". */
const PROTECTED_CATEGORIES: ReadonlySet<string> = new Set(['security', 'bug']);

/** Full-file scanner kinds that can never be demoted. */
const PROTECTED_KINDS: ReadonlySet<string> = new Set([
  'secret_leak',
  'lethal_trifecta',
  'phantom',
  'hook',
]);

/**
 * Common words carrying no scope signal. Applied to BOTH sides of a token
 * match so that e.g. `out_of_scope: ["anything related to the tests"]` cannot
 * match on "related" + "anything" alone.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  'about',
  'after',
  'also',
  'anything',
  'been',
  'before',
  'both',
  'change',
  'changed',
  'changes',
  'code',
  'could',
  'does',
  'everything',
  'file',
  'files',
  'from',
  'have',
  'here',
  'into',
  'just',
  'must',
  'none',
  'only',
  'other',
  'part',
  'parts',
  'related',
  'should',
  'some',
  'such',
  'than',
  'that',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'thing',
  'things',
  'this',
  'those',
  'were',
  'when',
  'which',
  'while',
  'will',
  'with',
  'would',
  'your',
]);

/** Minimum token length that counts as content (shorter words are noise). */
const MIN_TOKEN_LENGTH = 4;
/** Distinct content tokens an entry must share with a finding to match it. */
const MIN_TOKEN_OVERLAP = 2;

/** A single demotion, for the run log and the outcome. */
export interface ScopeDemotion {
  finding: Finding;
  /** Severity before the filter ran. */
  from: Severity;
  /** Severity after (equal to `from` for an already-SUGGESTION finding). */
  to: Severity;
  /** The `out_of_scope` entry that matched. */
  entry: string;
  /** Human-readable reason, e.g. `outside stated scope: "docs/"`. */
  reason: string;
}

export interface ScopeResult {
  /** Same findings, same order, same length — some demoted and tagged. */
  findings: Finding[];
  demoted: ScopeDemotion[];
  /**
   * True when the filter deliberately did nothing because the intent's
   * confidence was `low` or absent. Lets the caller log the no-op instead of
   * re-deriving the gate rule.
   */
  skippedLowConfidence: boolean;
}

/**
 * The hard escape hatch, evaluated FIRST for every finding. A finding matching
 * any clause is untouchable regardless of what the intent says.
 */
export function isScopeExempt(finding: Finding): boolean {
  if (finding.severity === 'CRITICAL') return true;
  if (PROTECTED_CATEGORIES.has(finding.category)) return true;
  if (finding.kind != null && PROTECTED_KINDS.has(finding.kind)) return true;
  return false;
}

/** `.ts`, `.tsx`, `.md` … — a trailing dot-extension makes an entry path-like. */
const FILE_EXTENSION_RE = /\.[A-Za-z0-9]{1,8}$/;

/** An entry is treated as a path/glob when it contains `/`, `*`, or an extension. */
function isPathLike(entry: string): boolean {
  const e = entry.trim();
  return e.includes('/') || e.includes('*') || FILE_EXTENSION_RE.test(e);
}

function normalizePath(p: string): string {
  return p.trim().replace(/^\.\//, '').replace(/\/+$/, '');
}

function globToRegExp(pattern: string): RegExp {
  // Escape every regex metacharacter EXCEPT `*`, then expand `**` (which may
  // cross path separators) and a single `*` (which may not). DOUBLE_STAR is a
  // private-use sentinel holding the `**` slot between the two passes.
  const DOUBLE_STAR = '\uE000';
  const escaped = pattern.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
  const body = escaped
    .replaceAll('**', DOUBLE_STAR)
    .replaceAll('*', '[^/]*')
    .replaceAll(DOUBLE_STAR, '.*');
  return new RegExp(`^${body}$`);
}

function pathMatches(entry: string, file: string): boolean {
  const e = normalizePath(entry);
  const f = normalizePath(file);
  if (!e || !f) return false;
  if (e.includes('*')) {
    const re = globToRegExp(e);
    if (re.test(f)) return true;
    // A bare pattern like `*.css` should still match a nested `src/theme.css`.
    if (!e.includes('/')) return re.test(f.split('/').pop() ?? '');
    return false;
  }
  // Exact file, directory prefix, or path-suffix (`components/Foo.tsx`).
  return f === e || f.startsWith(`${e}/`) || f.endsWith(`/${e}`);
}

function contentTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(raw)) out.add(raw);
  }
  return out;
}

/**
 * Does one scope entry match a finding? Path/glob entries match `finding.file`
 * only; everything else needs ≥2 distinct content tokens shared with
 * `file + ' ' + title`. An entry with fewer than 2 content tokens of its own
 * can never match — deliberately conservative, since a 1-token match on
 * model-authored free text is far too easy to trip.
 */
export function scopeEntryMatches(entry: string, finding: Finding): boolean {
  if (!entry.trim()) return false;
  if (isPathLike(entry)) return pathMatches(entry, finding.file);

  const wanted = contentTokens(entry);
  if (wanted.size < MIN_TOKEN_OVERLAP) return false;
  const haystack = contentTokens(`${finding.file} ${finding.title}`);
  let hits = 0;
  for (const token of wanted) {
    if (haystack.has(token)) hits += 1;
    if (hits >= MIN_TOKEN_OVERLAP) return true;
  }
  return false;
}

function firstMatch(entries: readonly string[] | undefined, finding: Finding): string | undefined {
  if (!entries) return undefined;
  for (const entry of entries) {
    if (scopeEntryMatches(entry, finding)) return entry;
  }
  return undefined;
}

/** WARNING softens one step; SUGGESTION is tagged but keeps its severity. */
function demotedSeverity(severity: Severity): Severity {
  return severity === 'WARNING' ? 'SUGGESTION' : severity;
}

/**
 * Demote (never delete) findings the derived intent puts out of scope.
 *
 * No-op when `intent` is absent or its `confidence_level` is `low`/null: an
 * intent inferred from a title and some file names is not evidence enough to
 * soften anything, even though it still reaches the prompt as context.
 */
export function applyScopeFilter(
  findings: Finding[],
  intent?: IntentForPrompt | null,
): ScopeResult {
  if (!intent) return { findings, demoted: [], skippedLowConfidence: false };

  const level = intent.confidence_level ?? null;
  if (level !== 'medium' && level !== 'high') {
    return { findings, demoted: [], skippedLowConfidence: true };
  }

  const demoted: ScopeDemotion[] = [];
  const out = findings.map((finding) => {
    // 1. Hard escape hatch, before anything else.
    if (isScopeExempt(finding)) return finding;
    // 2. Does any out-of-scope entry match?
    const entry = firstMatch(intent.out_of_scope, finding);
    if (entry === undefined) return finding;
    // 3. In-scope wins over out-of-scope.
    if (firstMatch(intent.in_scope, finding) !== undefined) return finding;

    const from = finding.severity;
    const to = demotedSeverity(from);
    const reason = `outside stated scope: "${entry}"`;
    const scope_note =
      from === to ? `kept ${from}; ${reason}` : `demoted ${from}→${to}; ${reason}`;
    const next: Finding = { ...finding, severity: to, out_of_scope: true, scope_note };
    demoted.push({ finding: next, from, to, entry, reason });
    return next;
  });

  return { findings: out, demoted, skippedLowConfidence: false };
}
