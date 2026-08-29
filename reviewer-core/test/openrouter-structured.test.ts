/* What `completeStructured` says when it gives up.

   The repair loop reports every unparseable response the same way, which makes
   two very different faults look identical: a model that answered badly, and a
   model that was cut off before it answered at all. The second is a caller
   configuration problem — on a reasoning model the reasoning tokens are drawn
   from `max_tokens` first, so too small a cap yields EMPTY content — and it
   shipped once already, diagnosed as "the provider is unreachable".

   The thrown message therefore has to carry our own diagnosis. It must not
   carry the provider's response body: a caller that is forbidden from echoing
   one (SPEC-02 AC-31) still needs to surface this. */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { OpenRouterProvider } from '../src/llm/openrouter.js';

const Schema = z.object({ what: z.string() });

/** Drive the provider against a canned completion, with no network. */
function providerReturning(completion: unknown) {
  const provider = new OpenRouterProvider('test-key');
  let calls = 0;
  (provider as unknown as { client: { chat: { completions: { create: unknown } } } }).client = {
    chat: {
      completions: {
        create: async () => {
          calls += 1;
          return completion;
        },
      },
    },
  };
  return { provider, calls: () => calls };
}

const request = {
  model: 'deepseek/deepseek-v4-pro',
  schema: Schema,
  schemaName: 'risk_brief',
  maxTokens: 1_200,
  maxRetries: 1,
  messages: [{ role: 'user' as const, content: 'brief this pr' }],
};

describe('completeStructured — giving up', () => {
  it('names the completion cap when the model was cut off with nothing to show', async () => {
    const { provider } = providerReturning({
      choices: [{ message: { content: '' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 3_386, completion_tokens: 1_200, completion_tokens_details: { reasoning_tokens: 1_200 } },
    });

    await expect(provider.completeStructured(request)).rejects.toThrow(
      /hit the completion cap/i,
    );
  });

  it('carries the evidence a reader needs to act — and nothing the model wrote', async () => {
    const { provider } = providerReturning({
      choices: [{ message: { content: '' }, finish_reason: 'length' }],
      usage: { completion_tokens_details: { reasoning_tokens: 1_200 } },
    });

    const err = await provider.completeStructured(request).catch((e: Error) => e);
    const message = (err as Error).message;
    expect(message).toContain('finish_reason=length');
    expect(message).toContain('content=empty');
    expect(message).toContain('reasoning_tokens=1200');
    expect(message).toContain('max_tokens=1200');
    // The actionable half: what to change.
    expect(message).toMatch(/raise maxTokens/i);
  });

  it('does not blame the cap when the model answered, just not to schema', async () => {
    const { provider } = providerReturning({
      choices: [{ message: { content: '{"wrong":"shape"}' }, finish_reason: 'stop' }],
      usage: { completion_tokens: 40 },
    });

    const err = await provider.completeStructured(request).catch((e: Error) => e);
    const message = (err as Error).message;
    expect(message).toMatch(/failed schema validation/i);
    expect(message).not.toMatch(/completion cap/i);
    // Still says what it saw, so the two branches are equally diagnosable.
    expect(message).toContain('finish_reason=stop');
    expect(message).toContain('17 chars');
  });

  it('retries before giving up, so a transient bad answer is not fatal', async () => {
    const { provider, calls } = providerReturning({
      choices: [{ message: { content: 'not json' }, finish_reason: 'stop' }],
      usage: {},
    });
    await provider.completeStructured({ ...request, maxRetries: 2 }).catch(() => undefined);
    expect(calls()).toBe(3); // maxRetries + 1
  });

  it('still parses a good response, with the diagnosis code path untouched', async () => {
    const { provider } = providerReturning({
      choices: [{ message: { content: '{"what":"adds a limiter"}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    const out = await provider.completeStructured(request);
    expect(out.data).toEqual({ what: 'adds a limiter' });
    expect(out.attempts).toBe(1);
  });
});
