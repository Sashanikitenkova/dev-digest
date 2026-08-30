import { toJsonSchema } from '@devdigest/reviewer-core';
import { AppError } from '../../platform/errors.js';
import { BRIEF_SCHEMA_NAME, BRIEF_TOKEN_BUDGET, MESSAGE_ENVELOPE_TOKENS } from './constants.js';
import { DraftedBrief, SYSTEM_PROMPT } from './prompt.js';

/**
 * Token accounting for the brief's single model call.
 *
 * The budget covers the COMPLETE model input — the system message, the user
 * message, AND the serialized JSON schema handed to `completeStructured` —
 * because all three are sent on the wire. Counting only the user message
 * under-reports by whatever the system prompt and the schema weigh, which for
 * this feature is well over a thousand tokens: the gate would then pass a
 * payload that is genuinely over budget.
 *
 * Counting is done through the injected `count`, which the service supplies as
 * `container.tokenizer.count` (`cl100k_base` via js-tiktoken). Never the
 * `ceil(chars / 4)` heuristic the tokenizer adapter also exports: that is a
 * DISPLAYED ESTIMATE elsewhere in this codebase, and it is wrong by tens of
 * percent on code and on paths, which is exactly what this feature is made of.
 */

let schemaJson: string | undefined;

/**
 * The exact string the provider will serialize as
 * `response_format.json_schema`.
 *
 * `toJsonSchema` is imported from reviewer-core's barrel — the SAME function
 * `OpenRouterProvider.completeStructured` calls on the same schema
 * (`reviewer-core/src/llm/openrouter.ts:60`), and the object literal below is
 * the one it places in the request body (`:74-77`). Hand-rolling this
 * serialization would drift from the wire format the first time the converter
 * changed, and the drift would be silent: the count would still look right.
 *
 * `DraftedBrief` is static, so the result is memoized at module scope.
 */
export function briefSchemaJson(): string {
  if (schemaJson === undefined) {
    const { schema } = toJsonSchema(DraftedBrief, BRIEF_SCHEMA_NAME);
    schemaJson = JSON.stringify({ name: BRIEF_SCHEMA_NAME, schema, strict: true });
  }
  return schemaJson;
}

/** Memoized per `count` function identity — one entry per tokenizer instance. */
const overheadByCounter = new WeakMap<(text: string) => number, number>();

/**
 * Everything in the payload that does NOT change while shedding: the system
 * message, the serialized schema, and one chat envelope allowance per message.
 *
 * This is what `shedToBudget` needs as `overheadTokens` — without it the
 * shedding loop measures a fraction of the payload and stops shedding early.
 */
export function fixedOverheadTokens(count: (text: string) => number): number {
  const cached = overheadByCounter.get(count);
  if (cached !== undefined) return cached;
  const total = count(SYSTEM_PROMPT) + count(briefSchemaJson()) + 2 * MESSAGE_ENVELOPE_TOKENS;
  overheadByCounter.set(count, total);
  return total;
}

/** The number AC-13 constrains: system + user + schema + both envelopes. */
export function payloadTokens(input: {
  system: string;
  user: string;
  count: (text: string) => number;
}): number {
  const { system, user, count } = input;
  return count(system) + count(user) + count(briefSchemaJson()) + 2 * MESSAGE_ENVELOPE_TOKENS;
}

/**
 * The final gate, called immediately before `completeStructured` and after
 * every trimming step has run.
 *
 * A should-never-fire guard on the shedding loop, not a user-facing outcome:
 * `assertFloorFits` has already refused the genuinely-too-large case with a
 * 422 before anything was spent. Reaching here over budget means the loop and
 * the floor disagree, which is a bug, so it fails loudly as a 500 rather than
 * quietly sending an over-budget payload. Deliberately NOT an `AppError` — it
 * is not a domain failure mode and must not acquire a code clients can handle.
 */
export function assertWithinBudget(total: number): void {
  if (total > BRIEF_TOKEN_BUDGET) {
    throw new Error(
      `brief input budget invariant broken: ${total} tokens after shedding exceeds ` +
        `${BRIEF_TOKEN_BUDGET}; the protected floor and the shedding loop disagree`,
    );
  }
}

/**
 * Refuse to gate on a counter that is no longer counting `cl100k_base`.
 *
 * `TiktokenTokenizer` falls back to `ceil(chars / 4)` for the rest of the
 * process if the BPE ranks ever fail to load, and does so silently — the right
 * call for the repo-map renderer, which must never throw, and the wrong one
 * here. AC-13 promises a ceiling counted by the real encoder; enforcing it with
 * a heuristic that is wrong by tens of percent on exactly the content this
 * feature is made of (code, paths) would make the promise false at runtime with
 * no signal at all.
 *
 * So the gate fails closed. Refusing to generate is a bad outcome; quietly
 * sending an over-budget payload while claiming an 8 000-token bound is a worse
 * one, because nothing downstream can detect it.
 *
 * Call AFTER at least one `count`, or the encoder will not yet have been
 * initialised and the flag will read false for the wrong reason.
 */
export function assertEncoderIntact(degraded: boolean | undefined): void {
  if (degraded === true) {
    throw new AppError(
      'brief_token_count_degraded',
      `The ${BRIEF_TOKEN_BUDGET}-token input budget could not be enforced: the cl100k_base ` +
        `encoder failed to load, so token counts fell back to a character heuristic. No brief ` +
        `was generated.`,
      503,
    );
  }
}

/**
 * Refuse, before anything is spent, a pull request whose MANDATORY inputs
 * alone do not fit.
 *
 * Called before provider resolution and before any adapter is touched, so
 * "zero LLM calls" is structural rather than a matter of ordering luck: there
 * is no code path from here to `container.llm`.
 */
export function assertFloorFits(input: {
  protectedUser: string;
  count: (text: string) => number;
}): void {
  const total = fixedOverheadTokens(input.count) + input.count(input.protectedUser);
  if (total > BRIEF_TOKEN_BUDGET) {
    throw new AppError(
      'brief_input_too_large',
      `This pull request's mandatory inputs are ${total} tokens, which exceeds the brief's ` +
        `${BRIEF_TOKEN_BUDGET}-token input budget; no brief was generated.`,
      422,
    );
  }
}
