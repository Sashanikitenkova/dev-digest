/**
 * Smart-diff file classifier (`modules/smart-diff/classify.ts`) — the pure
 * path → core|wiring|boilerplate mapping that decides the reviewer's reading
 * order. It runs with no DB, no index and no model, so it gets unit coverage
 * independent of the route.
 */
import { describe, it, expect } from 'vitest';
import { classifyFile } from '../src/modules/smart-diff/classify.js';
import { CLASSIFICATION_RULES } from '../src/modules/smart-diff/constants.js';

describe('classifyFile', () => {
  it('classifies lockfiles as boilerplate, wherever they sit in the tree', () => {
    expect(classifyFile('package-lock.json')).toBe('boilerplate');
    expect(classifyFile('pnpm-lock.yaml')).toBe('boilerplate');
    expect(classifyFile('bun.lockb')).toBe('boilerplate');
    expect(classifyFile('client/yarn.lock')).toBe('boilerplate');
    expect(classifyFile('services/api/go.sum')).toBe('boilerplate');
  });

  it('classifies generated output as boilerplate', () => {
    expect(classifyFile('dist/bundle.js')).toBe('boilerplate');
    expect(classifyFile('src/__snapshots__/Button.test.tsx.snap')).toBe('boilerplate');
    expect(classifyFile('server/drizzle/0007_add_findings.sql')).toBe('boilerplate');
    expect(classifyFile('public/app.min.js')).toBe('boilerplate');
  });

  it('classifies config, barrels and route registration as wiring', () => {
    expect(classifyFile('vite.config.ts')).toBe('wiring');
    expect(classifyFile('tsconfig.json')).toBe('wiring');
    expect(classifyFile('package.json')).toBe('wiring');
    expect(classifyFile('src/api/public/index.ts')).toBe('wiring');
    expect(classifyFile('src/modules/pulls/routes.ts')).toBe('wiring');
    expect(classifyFile('src/platform/container.ts')).toBe('wiring');
    expect(classifyFile('src/server.ts')).toBe('wiring');
    expect(classifyFile('src/config.ts')).toBe('wiring');
  });

  it('classifies everything else — actual logic — as core', () => {
    expect(classifyFile('src/middleware/ratelimit.ts')).toBe('core');
    expect(classifyFile('src/api/public/webhooks.ts')).toBe('core');
    expect(classifyFile('README.md')).toBe('core');
  });

  // ---- ambiguous edges: two rules could fire, order decides ----

  it('prefers boilerplate over wiring when a generated file looks like a barrel', () => {
    // `dist/index.js` matches BOTH the build-output rule and the barrel rule.
    // Generated-ness is the fact that matters, so boilerplate must win.
    expect(classifyFile('dist/index.js')).toBe('boilerplate');
    expect(classifyFile('build/routes.js')).toBe('boilerplate');
  });

  it('does not mistake a path that merely CONTAINS a rule name', () => {
    // `distribution/` is not `dist/`, and `indexer.ts` is not `index.ts`.
    expect(classifyFile('src/distribution/payout.ts')).toBe('core');
    expect(classifyFile('src/search/indexer.ts')).toBe('core');
    expect(classifyFile('src/config/rates.ts')).toBe('core');
  });

  it('normalizes Windows separators and leading ./ before matching', () => {
    expect(classifyFile('src\\api\\public\\index.ts')).toBe('wiring');
    expect(classifyFile('./package-lock.json')).toBe('boilerplate');
  });

  it('matches case-insensitively', () => {
    expect(classifyFile('Dockerfile')).toBe('wiring');
    expect(classifyFile('DIST/main.js')).toBe('boilerplate');
  });
});

describe('CLASSIFICATION_RULES', () => {
  it('carries no global RegExps — a stateful lastIndex would match every other call', () => {
    for (const rule of CLASSIFICATION_RULES) {
      expect(rule.test.global, `${rule.label} must not use the g flag`).toBe(false);
    }
  });

  it('is stable across repeated calls for the same path', () => {
    const path = 'src/api/public/index.ts';
    expect([classifyFile(path), classifyFile(path), classifyFile(path)]).toEqual([
      'wiring',
      'wiring',
      'wiring',
    ]);
  });
});
