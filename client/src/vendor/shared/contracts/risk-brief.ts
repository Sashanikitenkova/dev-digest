import { z } from 'zod';

/**
 * Risk Brief — what a pull request is, why it exists, how risky it is, and
 * what to read first. Stored in `pr_brief.json` and returned by
 * `GET/POST /pulls/:id/brief` and `POST /pulls/:id/brief/regenerate`.
 *
 * A NEW contract file rather than an edit to `contracts/brief.ts`: the barrel
 * is stable and feature work EXTENDS it with new files. Every name here is
 * `RiskBrief*` / `PrRiskBrief*` on purpose — `PrBrief`, `Risk`, `Risks` and
 * `RiskSeverity` are already taken in `contracts/brief.ts` for different
 * shapes (`PrBrief` is the composed Intent + BlastRadius + Risks + PrHistory
 * read-model; `Risk` is one entry of the deterministic risk scan).
 *
 * This file lands in BOTH vendored copies (`server/src/vendor/shared/`,
 * `client/src/vendor/shared/`), which are committed duplicates with no sync
 * step — every edit is made twice, identically.
 */

/** Severity of one risk, and the overall risk level of the pull request. */
export const RiskBriefLevel = z.enum(['low', 'medium', 'high']);
export type RiskBriefLevel = z.infer<typeof RiskBriefLevel>;

/**
 * A string field COUNTS AS CARRIED only when it is non-null, non-undefined and
 * non-empty after `trim()`. A present key whose value is `null` or `""` is not
 * a value.
 */
const carriesText = (value: string | null | undefined): boolean =>
  typeof value === 'string' && value.trim().length > 0;

/**
 * Where a risk or a review-focus item points. Every field is optional on the
 * wire, but the object is valid only when it actually carries something the
 * server can check against its allowlist and per-file line index:
 *
 *  - at least one carried field — `{}`, `{ file: null }` and `{ file: '' }` are
 *    all rejected;
 *  - a `line` without a `file` is rejected: such a reference can neither be
 *    validated against a file's valid-line set nor rendered as `file:line`;
 *  - a carried `line` must be a positive integer (1-based, new side).
 *
 * Each rule carries its own message, so a failure names the rule that produced
 * it rather than one generic string.
 */
export const RiskBriefReference = z
  .object({
    file: z.string().nullish(),
    line: z.number().int().nullish(),
    symbol: z.string().nullish(),
    endpoint: z.string().nullish(),
  })
  .superRefine((ref, ctx) => {
    const hasFile = carriesText(ref.file);
    const hasSymbol = carriesText(ref.symbol);
    const hasEndpoint = carriesText(ref.endpoint);
    const line = typeof ref.line === 'number' ? ref.line : null;

    if (!hasFile && !hasSymbol && !hasEndpoint && line === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'reference carries no field: at least one of file, symbol, endpoint or line must be present and non-empty',
      });
    }

    if (line !== null && !hasFile) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['line'],
        message: 'reference carries a line without a file',
      });
    }

    if (line !== null && line <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['line'],
        message: 'reference line must be a positive integer',
      });
    }
  });
export type RiskBriefReference = z.infer<typeof RiskBriefReference>;

/** One risk the model raised, with the reference it is anchored to. */
export const RiskBriefRiskItem = z.object({
  severity: RiskBriefLevel,
  summary: z.string(),
  reference: RiskBriefReference,
});
export type RiskBriefRiskItem = z.infer<typeof RiskBriefRiskItem>;

/** One "read this first" pointer into the pull request's changes. */
export const RiskBriefFocusItem = z.object({
  summary: z.string(),
  reference: RiskBriefReference,
});
export type RiskBriefFocusItem = z.infer<typeof RiskBriefFocusItem>;

/**
 * One line of the input ledger: what the generator had, what it removed to fit
 * the token budget, and what it could not retrieve. Deliberately three states —
 * an input that was BOUNDED or CAPPED stays `present` with a `reason` naming
 * the bound, rather than gaining a fourth status, so a reduced input is never
 * reported as a removed one.
 */
export const RiskBriefInputEntry = z.object({
  section: z.string(),
  status: z.enum(['present', 'removed', 'unavailable']),
  reason: z.string().nullish(),
});
export type RiskBriefInputEntry = z.infer<typeof RiskBriefInputEntry>;

/**
 * How many items the model proposed and how many survived reference
 * validation, so that "the model invented every reference" and "the pull
 * request is genuinely low-risk" cannot present identically as an empty brief.
 */
export const RiskBriefCounts = z.object({
  risks_proposed: z.number().int(),
  risks_kept: z.number().int(),
  focus_proposed: z.number().int(),
  focus_kept: z.number().int(),
});
export type RiskBriefCounts = z.infer<typeof RiskBriefCounts>;

/**
 * The stored brief: one row per pull request, for its current head.
 *
 * `head_sha` is `.nullish()` because the column is nullable — a pre-migration
 * row then reads as STALE rather than as fresh for an unknown head. The
 * provenance fields mirror `pr_intent`'s nullable columns, so a brief written
 * by a call whose provider reported no usage still parses.
 *
 * No `.default([])` anywhere in this file: on a shared contract it makes the
 * key required on `z.infer` output, which breaks every existing constructor.
 */
export const PrRiskBriefRecord = z.object({
  pr_id: z.string(),
  what: z.string(),
  why: z.string(),
  risk_level: RiskBriefLevel,
  risks: z.array(RiskBriefRiskItem),
  review_focus: z.array(RiskBriefFocusItem),
  inputs: z.array(RiskBriefInputEntry),
  counts: RiskBriefCounts,
  /** Commit the brief was generated from; a different head sha means stale. */
  head_sha: z.string().nullish(),
  /** ISO timestamp of the generation that produced this row. */
  generated_at: z.string(),
  provider: z.string().nullish(),
  model: z.string().nullish(),
  tokens_in: z.number().int().nullish(),
  tokens_out: z.number().int().nullish(),
  cost_usd: z.number().nullish(),
});
export type PrRiskBriefRecord = z.infer<typeof PrRiskBriefRecord>;
