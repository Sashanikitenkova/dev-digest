/* The 8,000-token input budget.

   The unit is explicit in SPEC-02: cl100k_base tokens over the COMPLETE model
   input — the system message, the user message, and the serialized JSON schema
   the provider sends as `response_format.json_schema`. Counting only the user
   message is the defect the cross-model review of the plan found; on this
   codebase it under-reports by roughly 1,450 tokens, ~18% of the whole ceiling.

   `assertFloorFits` is the other half: a PR whose mandatory inputs alone exceed
   the budget must cost ZERO model calls, not a truncated one. */
import { describe, it, expect } from 'vitest';
import {
  briefSchemaJson,
  fixedOverheadTokens,
  payloadTokens,
  assertWithinBudget,
  assertFloorFits,
  assertEncoderIntact,
} from '../src/modules/brief/budget.js';
import {
  BRIEF_TOKEN_BUDGET,
  BRIEF_MAX_COMPLETION_TOKENS,
} from '../src/modules/brief/constants.js';
import { SYSTEM_PROMPT } from '../src/modules/brief/prompt.js';
import { TiktokenTokenizer } from '../src/adapters/tokenizer/index.js';
import { AppError } from '../src/platform/errors.js';

const count = (t: string) => Math.ceil(t.length / 4);

describe('briefSchemaJson', () => {
  it('serializes exactly the object the provider puts in response_format', () => {
    // OpenRouterProvider sends { name, schema, strict: true }. Counting a
    // hand-rolled shape here would drift from the wire format silently.
    const parsed = JSON.parse(briefSchemaJson());
    expect(parsed).toHaveProperty('name');
    expect(parsed).toHaveProperty('schema');
    expect(parsed.strict).toBe(true);
  });

  it('describes the five brief fields the contract requires', () => {
    const json = briefSchemaJson();
    for (const field of ['what', 'why', 'risk_level', 'risks', 'review_focus']) {
      expect(json).toContain(field);
    }
  });

  it('is stable across calls, so the overhead cannot drift mid-run', () => {
    expect(briefSchemaJson()).toBe(briefSchemaJson());
  });
});

describe('fixedOverheadTokens', () => {
  it('counts the system prompt AND the schema, not just one of them', () => {
    const overhead = fixedOverheadTokens(count);
    expect(overhead).toBeGreaterThan(count(SYSTEM_PROMPT));
    expect(overhead).toBeGreaterThan(count(briefSchemaJson()));
    expect(overhead).toBeGreaterThanOrEqual(count(SYSTEM_PROMPT) + count(briefSchemaJson()));
  });

  it('is a substantial share of the budget — the amount a user-only count would miss', () => {
    const real = new TiktokenTokenizer();
    const overhead = fixedOverheadTokens((t) => real.count(t));
    expect(overhead).toBeGreaterThan(500);
    expect(overhead).toBeLessThan(BRIEF_TOKEN_BUDGET);
  });
});

describe('payloadTokens', () => {
  it('sums system + user + schema', () => {
    const user = 'u'.repeat(400);
    const total = payloadTokens({ system: SYSTEM_PROMPT, user, count });
    expect(total).toBeGreaterThan(count(user) + count(SYSTEM_PROMPT));
    expect(total).toBeGreaterThanOrEqual(fixedOverheadTokens(count) + count(user));
  });

  it('grows with the user message', () => {
    const small = payloadTokens({ system: SYSTEM_PROMPT, user: 'x', count });
    const large = payloadTokens({ system: SYSTEM_PROMPT, user: 'x'.repeat(4_000), count });
    expect(large).toBeGreaterThan(small);
  });
});

describe('assertWithinBudget', () => {
  it('passes at and below the ceiling', () => {
    expect(() => assertWithinBudget(BRIEF_TOKEN_BUDGET)).not.toThrow();
    expect(() => assertWithinBudget(1)).not.toThrow();
  });

  it('throws above the ceiling — the shedding loop failing is a bug, not a user error', () => {
    expect(() => assertWithinBudget(BRIEF_TOKEN_BUDGET + 1)).toThrow();
  });
});

describe('assertFloorFits (AC-61)', () => {
  it('passes when the mandatory inputs leave room', () => {
    expect(() => assertFloorFits({ protectedUser: 'short', count })).not.toThrow();
  });

  it('throws AppError brief_input_too_large at 422 when the floor alone exceeds the budget', () => {
    // 200k chars ≈ 50k tokens at this counter — far past 8,000.
    let thrown: unknown;
    try {
      assertFloorFits({ protectedUser: 'x'.repeat(200_000), count });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe('brief_input_too_large');
    expect((thrown as AppError).statusCode).toBe(422);
  });

  it('accounts for the fixed overhead when judging the floor', () => {
    // A floor that fits on its own but not once the schema and system prompt
    // are added must still be refused.
    const overhead = fixedOverheadTokens(count);
    const justUnder = 'x'.repeat((BRIEF_TOKEN_BUDGET - overhead + 40) * 4);
    expect(() => assertFloorFits({ protectedUser: justUnder, count })).toThrow(AppError);
  });

  it('names the budget in its message, so the refusal is actionable', () => {
    try {
      assertFloorFits({ protectedUser: 'x'.repeat(200_000), count });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain(String(BRIEF_TOKEN_BUDGET));
    }
  });
});

describe('BRIEF_MAX_COMPLETION_TOKENS', () => {
  /*
   * The completion cap is not the size of the answer.
   *
   * The shipped default is a reasoning model, and on OpenRouter reasoning
   * tokens are drawn from `max_tokens` BEFORE any content. At 1_200 the model
   * spent the entire budget reasoning and returned empty content, which the
   * repair loop reported three attempts later as a schema-validation failure —
   * a 100% failure rate that every LLM-mocking test in this repo passed
   * straight through, because a mock consumes no tokens.
   *
   * 2_938 is the worst real completion measured against this feature's schema
   * with a 40-file prompt (deepseek-v4-flash: 1_430 reasoning + content). The
   * cap must clear it, or the failure returns silently.
   */
  const WORST_OBSERVED_COMPLETION = 2_938;

  it('clears the worst completion actually measured against a reasoning model', () => {
    expect(BRIEF_MAX_COMPLETION_TOKENS).toBeGreaterThanOrEqual(WORST_OBSERVED_COMPLETION);
  });

  it('leaves headroom above it rather than sitting exactly on the measurement', () => {
    expect(BRIEF_MAX_COMPLETION_TOKENS).toBeGreaterThan(WORST_OBSERVED_COMPLETION * 1.2);
  });

  it('stays a completion cap, not a second input budget', () => {
    // Sized independently of the 8,000-token INPUT ceiling; if someone ever
    // conflates the two, this is the line that says they are different things.
    expect(BRIEF_MAX_COMPLETION_TOKENS).toBeLessThan(BRIEF_TOKEN_BUDGET);
  });
});

describe('assertEncoderIntact (AC-66, EC-25)', () => {
  it('refuses to gate the budget on the character heuristic', () => {
    // The gate promises a ceiling in cl100k_base tokens. Once the encoder is
    // gone the numbers are off by tens of percent on exactly this feature's
    // content, so the only honest outcomes are "refuse" or "lie".
    expect(() => assertEncoderIntact(true)).toThrow(AppError);
    try {
      assertEncoderIntact(true);
    } catch (err) {
      expect((err as AppError).statusCode).toBe(503);
      expect((err as AppError).code).toBe('brief_token_count_degraded');
      expect((err as Error).message).toMatch(/cl100k_base/);
      expect((err as Error).message).toMatch(/No brief was generated/i);
    }
  });

  it('passes for an intact encoder, and for a mock counter that omits the flag', () => {
    expect(() => assertEncoderIntact(false)).not.toThrow();
    // Every test injects a bare function-backed counter with no `degraded`
    // member. Absent must mean "fine", or the whole suite fails closed.
    expect(() => assertEncoderIntact(undefined)).not.toThrow();
  });

  it('latches on the real tokenizer once the encoder has failed', async () => {
    const tok = new TiktokenTokenizer();
    expect(tok.count('hello world')).toBeGreaterThan(0);
    expect(tok.degraded).toBe(false);
    expect(() => assertEncoderIntact(tok.degraded)).not.toThrow();

    // Kill the encoder the way a BPE load failure would, then confirm the
    // adapter both falls back AND says so.
    (tok as unknown as { enc: { encode: () => number[] } }).enc = {
      encode: () => {
        throw new Error('BPE ranks unavailable');
      },
    };
    const text = 'a'.repeat(400);
    expect(tok.count(text)).toBe(100); // ceil(400 / 4) — the heuristic
    expect(tok.degraded).toBe(true);
    expect(() => assertEncoderIntact(tok.degraded)).toThrow(/could not be enforced/i);
  });
});
