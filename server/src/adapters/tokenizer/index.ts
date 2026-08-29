/**
 * tokenizer adapter — the server's token counter for any SERVER-SIDE TOKEN
 * GATE: a place where the number decides what is sent to a model.
 *
 * Two consumers today:
 *   • the repo-map renderer (modules/repo-intel/pipeline/repo-map.ts), which
 *     binary-searches the largest set of symbols that fits a budget — that
 *     loop calls `count()` ≤ ~13 times;
 *   • the Why + Risk brief (modules/brief/budget.ts), which counts the
 *     complete model input — system message, user message and the serialized
 *     JSON schema — and refuses to make the call if it exceeds the budget.
 *
 * NOT every token number in this server belongs here. `modules/context/
 * helpers.ts:17-24` deliberately keeps the `ceil(chars / 4)` heuristic,
 * because it is a DISPLAYED ESTIMATE that has to match a browser-side
 * computation exactly; agreeing with the other end matters more there than
 * being right. A gate is the opposite case: it must not overshoot, so it uses
 * the real encoder.
 *
 * Default impl: js-tiktoken `cl100k_base` (pure-JS, no natives). The encoder is
 * lazy-initialised (loading the BPE ranks is the heavy part) and any failure
 * falls back to the `ceil(chars / 4)` heuristic — the renderer must never throw.
 *
 * That fallback is RIGHT for the repo-map renderer, which is shaping a budget it
 * may miss by a little, and WRONG for a gate that promises a hard ceiling: the
 * heuristic is off by tens of percent on code and paths, so a gate trusting it
 * would wave through a payload that is genuinely over budget. `degraded` exists
 * so the two consumers can diverge — the renderer ignores it and keeps going,
 * the brief's budget gate reads it and fails closed rather than enforce an
 * 8 000-token promise with a counter it does not believe.
 *
 * Scope: in-process. Swappable in tests via a mock counter
 * (ContainerOverrides.tokenizer).
 */
import { getEncoding, type Tiktoken } from 'js-tiktoken';

export interface Tokenizer {
  count(text: string): number;
  /**
   * True once the real encoder has failed and `count` has fallen back to the
   * `ceil(chars / 4)` heuristic for the rest of this process.
   *
   * Optional so that a mock counter — every test injects a bare function-backed
   * one — satisfies the port without restating it. Absent means "never
   * degraded"; a gate MUST treat `=== true` as the only degraded signal.
   */
  readonly degraded?: boolean;
}

/** Heuristic fallback used before/instead of a real encoder. */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class TiktokenTokenizer implements Tokenizer {
  private enc?: Tiktoken;
  private broken = false;

  /**
   * Latched, never reset: one BPE failure means this process has no real
   * encoder, and a later `count` returning a heuristic number is not evidence
   * that the encoder recovered.
   */
  get degraded(): boolean {
    return this.broken;
  }

  count(text: string): number {
    if (this.broken) return approxTokens(text);
    try {
      this.enc ??= getEncoding('cl100k_base');
      return this.enc.encode(text).length;
    } catch {
      // BPE load failed once — don't retry per call; stick to the heuristic.
      // `degraded` now reads true, which is how a budget gate learns that the
      // numbers below it stopped being cl100k_base counts.
      this.broken = true;
      return approxTokens(text);
    }
  }
}
