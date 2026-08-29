/**
 * Smart Diff's load-bearing invariant: it never calls a model.
 *
 * The whole point of the feature is that the reading order exists the instant a
 * PR is imported, before any review has run — so `service.ts` states "NO MODEL
 * IS CALLED HERE, and none may be added", `classify.ts` says "explicitly NO
 * model call", and `helpers.ts` pins `pseudocode_summary` to null for the same
 * reason. Three docblocks, and until now nothing enforcing any of them.
 *
 * This is the static half: no module in `modules/smart-diff/` may reference an
 * LLM seam at all. It needs no DB and no Docker, so it runs everywhere. The
 * runtime half — mock providers injected into a real app, asserted at zero
 * calls — lives in `smart-diff.it.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = fileURLToPath(new URL('../src/modules/smart-diff/', import.meta.url));

/**
 * Seams that reach a model. `container.llm(` is the only way to resolve a
 * provider; `RunLogger` is the sink every model call is logged through; and
 * `assemblePrompt` / `reviewer-core` are the review engine itself. A file
 * touching any of them has left the deterministic path.
 */
const FORBIDDEN: readonly { pattern: RegExp; seam: string }[] = [
  { pattern: /container\s*\.\s*llm\b/, seam: 'container.llm() — resolves a provider' },
  { pattern: /\bLLMProvider\b/, seam: 'LLMProvider' },
  { pattern: /reviewer-core/, seam: 'reviewer-core (the review engine)' },
  { pattern: /\bRunLogger\b/, seam: 'RunLogger — the model-call log sink' },
  { pattern: /\bassemblePrompt\b/, seam: 'assemblePrompt' },
];

const sourceFiles = readdirSync(MODULE_DIR)
  .filter((f) => f.endsWith('.ts'))
  .sort();

describe('smart-diff makes no model call', () => {
  it('has source files to check (guards against a silently empty scan)', () => {
    // A rename or a move would otherwise turn this whole suite into a no-op
    // that passes forever while checking nothing.
    expect(sourceFiles).toEqual([
      'classify.ts',
      'constants.ts',
      'helpers.ts',
      'repository.ts',
      'routes.ts',
      'service.ts',
    ]);
  });

  it.each(sourceFiles)('%s references no LLM seam', (file) => {
    const src = readFileSync(join(MODULE_DIR, file), 'utf8');
    for (const { pattern, seam } of FORBIDDEN) {
      expect(
        pattern.test(src),
        `${file} references ${seam}. Smart Diff must stay deterministic — see the ` +
          'docblock in service.ts.',
      ).toBe(false);
    }
  });

  it('keeps pseudocode_summary null rather than generating one', () => {
    // The contract carries the field, but filling it in means a model call.
    // A later lesson adds it; until then null is the correct answer.
    const helpers = readFileSync(join(MODULE_DIR, 'helpers.ts'), 'utf8');
    expect(helpers).toMatch(/pseudocode_summary:\s*null/);
  });
});
