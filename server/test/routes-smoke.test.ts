import { describe, it, expect, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { MockGitHubClient, MockLLMProvider } from '../src/adapters/mocks.js';

/**
 * No-DB route smoke tests via app.inject(). `/health` and the validation/error
 * envelope don't touch the database (postgres-js connects lazily), so these run
 * without Docker. DB-backed routes are covered in integration.test.ts.
 */
const config = loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);

describe('routes (no DB)', () => {
  it('GET /health → ok', async () => {
    const app = await buildApp({ config });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });

  it('POST /settings/test-connection (github) returns structured ConnTestResult', async () => {
    const app = await buildApp({
      config,
      overrides: { github: new MockGitHubClient({ login: 'octocat' }) },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/settings/test-connection',
      payload: { provider: 'github' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.provider).toBe('github');
    expect(body.ok).toBe(true);
    expect(body.message).toContain('octocat');
    await app.close();
  });

  it('POST /settings/test-connection (openai) uses injected LLM listModels', async () => {
    const app = await buildApp({
      config,
      overrides: {
        llm: { openai: new MockLLMProvider('openai', { models: [{ id: 'gpt-4.1', provider: 'openai' }] }) },
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/settings/test-connection',
      payload: { provider: 'openai' },
    });
    expect(res.json().ok).toBe(true);
    await app.close();
  });

  /* A rate-limit rejection used to fall through to the error handler's generic
     tail: logged at `error` as if the server had broken, and returned as
     `internal_error` with the retry delay readable only as prose inside the
     message. The studio's context editor is the caller that hit it, and it
     needs a NUMBER to back off by. The limiter is disabled under NODE_ENV=test
     (app.ts), so this case builds the app as `development` to turn it on;
     `/settings/test-connection` carries its own `max: 20` override. */
  it('shapes a 429 as rate_limited, with the retry delay as a number', async () => {
    const app = await buildApp({
      config: {
        ...loadConfig({ ...process.env, NODE_ENV: 'development' } as NodeJS.ProcessEnv),
        logLevel: 'silent',
      },
      overrides: { github: new MockGitHubClient({ login: 'octocat' }) },
    });
    const hit = () =>
      app.inject({
        method: 'POST',
        url: '/settings/test-connection',
        payload: { provider: 'github' },
      });

    let res = await hit();
    for (let i = 0; i < 20 && res.statusCode !== 429; i++) res = await hit();

    expect(res.statusCode).toBe(429);
    const body = res.json();
    expect(body.error.code).toBe('rate_limited');
    expect(typeof body.error.details.retryAfter).toBe('number');
    // Seconds, not milliseconds — @fastify/rate-limit sends ceil(ttl / 1000).
    expect(body.error.details.retryAfter).toBeLessThanOrEqual(60);
    await app.close();
  });

  it('returns 422 structured error on invalid body', async () => {
    const app = await buildApp({ config });
    const res = await app.inject({
      method: 'POST',
      url: '/settings/test-connection',
      payload: { provider: 'not-a-provider' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('validation_error');
    await app.close();
  });

  it('rejects a non-uuid pr id on the intent routes at the edge', async () => {
    const app = await buildApp({ config });
    for (const url of ['/pulls/not-a-uuid/intent', '/pulls/not-a-uuid/intent/detect']) {
      const method = url.endsWith('detect') ? 'POST' : 'GET';
      const res = await app.inject({ method, url });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('validation_error');
    }
    await app.close();
  });
});
