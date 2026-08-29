import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

/**
 * COMPOSITION-ROOT ring.
 *
 * Every case passes a plain object as `env` rather than mutating
 * `process.env` — the vitest workers are shared, and a leaked mutation would
 * make an unrelated suite fail depending on file order.
 */

describe('loadConfig', () => {
  it('falls back to the dev defaults when nothing is set', () => {
    expect(loadConfig({})).toEqual({
      apiBaseUrl: 'http://localhost:3001',
      webBaseUrl: 'http://localhost:3000',
    });
  });

  it('honours explicit values', () => {
    const config = loadConfig({
      DEVDIGEST_API_BASE: 'http://api.internal:8080',
      DEVDIGEST_WEB_BASE: 'http://studio.internal:8081',
    });
    expect(config.apiBaseUrl).toBe('http://api.internal:8080');
    expect(config.webBaseUrl).toBe('http://studio.internal:8081');
  });

  it('strips trailing slashes — z.url() alone does not', () => {
    // Left unstripped, every request would build `//pulls/...`.
    const config = loadConfig({
      DEVDIGEST_API_BASE: 'http://localhost:3001/',
      DEVDIGEST_WEB_BASE: 'http://localhost:3000///',
    });
    expect(config.apiBaseUrl).toBe('http://localhost:3001');
    expect(config.webBaseUrl).toBe('http://localhost:3000');
  });

  it('rejects a malformed API base at startup rather than at first fetch', () => {
    expect(() => loadConfig({ DEVDIGEST_API_BASE: 'not-a-url' })).toThrow(ConfigError);
  });

  it('names the offending variable in the message', () => {
    expect(() => loadConfig({ DEVDIGEST_WEB_BASE: 'nope' })).toThrow(/DEVDIGEST_WEB_BASE/);
  });

  it('reports every offending variable at once, not just the first', () => {
    let message = '';
    try {
      loadConfig({ DEVDIGEST_API_BASE: 'nope', DEVDIGEST_WEB_BASE: 'also-nope' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('DEVDIGEST_API_BASE');
    expect(message).toContain('DEVDIGEST_WEB_BASE');
  });

  it('throws rather than exiting, so the process can report on stderr first', () => {
    // A process.exit() inside loadConfig would kill the vitest worker here.
    expect(() => loadConfig({ DEVDIGEST_API_BASE: 'nope' })).toThrow(ConfigError);
  });
});
