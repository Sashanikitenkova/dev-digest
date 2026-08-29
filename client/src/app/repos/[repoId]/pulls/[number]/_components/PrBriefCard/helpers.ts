import { ApiError } from "../../../../../../../lib/api";
import { githubBlobUrl } from "../../../../../../../lib/github-urls";
import type {
  PrRiskBriefRecord,
  RiskBriefLevel,
  RiskBriefReference,
} from "../../../../../../../lib/types";

/** What a reference actually points at, once null/empty fields are discarded. */
export type ReferenceKind = "file" | "symbol" | "endpoint" | "none";

export interface ReferenceDescription {
  /** `path/to/file.ts:42`, `path/to/file.ts`, the symbol, or the endpoint. */
  label: string;
  kind: ReferenceKind;
  file: string | null;
  line: number | null;
}

/** A field counts as carried only when it is a non-empty string after trim. */
function carried(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Describe a reference for display, in the same precedence the server validates
 * it: file (with its line when present) first, then symbol, then endpoint.
 *
 * The server has already dropped every item whose reference failed validation,
 * so `none` should be unreachable in practice — it is handled anyway so a
 * malformed record degrades to "summary with no pointer" instead of throwing.
 */
export function describeReference(reference: RiskBriefReference): ReferenceDescription {
  const file = carried(reference.file);
  const line =
    typeof reference.line === "number" && Number.isInteger(reference.line) && reference.line > 0
      ? reference.line
      : null;

  if (file) {
    return { label: line == null ? file : `${file}:${line}`, kind: "file", file, line };
  }
  const symbol = carried(reference.symbol);
  if (symbol) return { label: symbol, kind: "symbol", file: null, line: null };

  const endpoint = carried(reference.endpoint);
  if (endpoint) return { label: endpoint, kind: "endpoint", file: null, line: null };

  return { label: "", kind: "none", file: null, line: null };
}

/**
 * Where a review-focus row navigates.
 *
 * - `in-diff` — the file is one of THIS pull request's changed files, so the
 *   studio's own diff view can show it: the row is a button handing the page a
 *   `(file, line)` pair. The tab to switch to is deliberately NOT decided here;
 *   a duplicated tab literal is how a shipped tab once became unreachable.
 * - `github` — the file is real but outside the diff (a caller, a config file),
 *   so github.com pinned to the head sha is the only target that can show it.
 * - `text` — a symbol-only or endpoint-only reference, or a file with no
 *   resolvable link. Rendered as PLAIN TEXT, never as a hrefless `MonoLink`:
 *   that renders a focusable `<button>` with `cursor: pointer` and no handler
 *   (`vendor/ui/primitives/MonoLink.tsx:42`), i.e. a dead control announced to
 *   a screen reader as a control — worse than the dead link this avoids.
 */
export type FocusTarget =
  | { kind: "in-diff"; file: string; line: number | null; label: string }
  | { kind: "github"; href: string; label: string }
  | { kind: "text"; label: string; labelKind: ReferenceKind };

export interface FocusTargetContext {
  /** Paths of the PR's changed files, compared by EXACT equality — the same
      opaque-string rule the server's allowlist uses. A case change or a `./`
      prefix does not match, and correctly falls through to the GitHub link. */
  changedFiles: readonly string[];
  repoFullName: string | null | undefined;
  headSha: string | null | undefined;
}

export function resolveFocusTarget(
  reference: RiskBriefReference,
  { changedFiles, repoFullName, headSha }: FocusTargetContext,
): FocusTarget {
  const described = describeReference(reference);

  if (described.kind === "file" && described.file) {
    const { file, line, label } = described;
    if (changedFiles.includes(file)) return { kind: "in-diff", file, line, label };
    if (repoFullName && headSha) {
      return {
        kind: "github",
        href: githubBlobUrl(repoFullName, headSha, file, line ?? undefined),
        label,
      };
    }
  }

  return { kind: "text", label: described.label, labelKind: described.kind };
}

/**
 * The query parameters of one focus navigation, as a SINGLE object.
 *
 * Two sequential single-key writes both build from the same `search` snapshot,
 * so the second silently drops the first — `tab`, `file` and `line` therefore
 * have to reach `urlWith` together, in one navigation. The `tab` VALUE is the
 * page's to choose and is passed in; this card never names it.
 */
export function focusParams(
  tab: string,
  file: string,
  line: number | null,
): Record<string, string | null> {
  return { tab, file, line: line == null ? null : String(line) };
}

/**
 * The brief describes a commit that is no longer the PR's head.
 *
 * A stored brief with NO head sha (a row written before the column existed)
 * reads as stale rather than as fresh for an unknown head — the same rule the
 * server's freshness check applies. When the PR's current head is unknown no
 * staleness can be claimed at all.
 */
export function isBriefStale(
  brief: PrRiskBriefRecord,
  headSha: string | null | undefined,
): boolean {
  if (!headSha) return false;
  return brief.head_sha !== headSha;
}

/**
 * The server's own words for a failed generation, not a euphemism for them.
 *
 * `ApiError` already carries the engine's message plus the HTTP status, and its
 * network branch says the API is unreachable — collapsing all of that into one
 * fixed sentence makes a 422 budget refusal, a 502 provider failure and a dead
 * API indistinguishable on screen, which is exactly when a user needs to know
 * which one it is. The generic string stays only as the fallback for a throw
 * that is not an `ApiError`.
 */
export function briefErrorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    return err.status > 0 ? `${fallback}: ${err.message} (HTTP ${err.status})` : err.message;
  }
  return fallback;
}

/** Risk-level accent. Always paired with the level's TEXT label, never alone. */
export function riskLevelColor(level: RiskBriefLevel): string {
  if (level === "high") return "var(--crit)";
  if (level === "medium") return "var(--warn)";
  return "var(--ok)";
}
