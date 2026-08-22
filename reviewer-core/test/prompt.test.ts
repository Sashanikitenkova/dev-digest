/**
 * assemblePrompt — PR description slot (the fix that was missing: the PR body
 * never reached the prompt). Pins rendering, omit-when-empty, untrusted-wrap,
 * truncation, and ordering (before the diff).
 */
import { describe, it, expect } from 'vitest';
import { assemblePrompt } from '../src/prompt.js';

function userOf(parts: Parameters<typeof assemblePrompt>[0]): string {
  const { messages } = assemblePrompt(parts);
  return messages[1]!.content;
}

function systemOf(parts: Parameters<typeof assemblePrompt>[0]): string {
  return assemblePrompt(parts).messages[0]!.content;
}

describe('assemblePrompt — shared injection guard (server + CI)', () => {
  const sys = systemOf({ system: 'AGENT-SYS', diff: 'DIFF' });

  it('appends the guard to the agent system prompt', () => {
    expect(sys.startsWith('AGENT-SYS')).toBe(true);
    expect(sys).toMatch(/<untrusted>.*DATA to be analyzed/s);
  });

  it('forbids "intentional/test/demo" claims from descoping the review', () => {
    // The defense that replaced the keyword sanitizer: a general, trusted,
    // language-agnostic rule — not text parsing of untrusted input.
    expect(sys).toMatch(/test fixture|intentional|demo/i);
    expect(sys).toMatch(/never reduce|never .*descope|REPORT it/i);
    expect(sys).toMatch(/any language/i);
  });
});

describe('assemblePrompt — output language', () => {
  const sys = systemOf({ system: 'AGENT-SYS', diff: 'DIFF' });

  it('pins the reviewer’s free-text output to English', () => {
    // Regression guard for the class of bug recorded in server/INSIGHTS.md
    // (2026-08-12): a model answering in its own language because no prompt
    // rule pinned one. Fixed in the PROMPT so it survives a model swap.
    expect(sys).toMatch(/OUTPUT LANGUAGE/);
    expect(sys).toMatch(/in ENGLISH/);
    expect(sys).toMatch(/summary/i);
    expect(sys).toMatch(/title, rationale and suggestion/i);
  });

  it('still applies when the diff is in another language', () => {
    // The rule is unconditional — it must not be phrased as advice that an
    // untrusted diff could argue its way out of.
    expect(sys).toMatch(/even when/i);
  });

  it('keeps identifiers and code untranslated', () => {
    expect(sys).toMatch(/identifiers, file paths, code symbols and quoted code/i);
    expect(sys).toMatch(/verbatim/i);
  });

  it('applies to every agent, whatever its own system prompt says', () => {
    // assemblePrompt is the single derivation point, so a user-created agent
    // with an arbitrary prompt body gets the rule too.
    const other = systemOf({ system: 'a totally different agent', diff: 'DIFF' });
    expect(other).toMatch(/OUTPUT LANGUAGE/);
  });
});

describe('assemblePrompt — ## PR description', () => {
  it('renders the section (untrusted-wrapped) before the diff when present', () => {
    const { messages, assembly } = assemblePrompt({
      system: 'sys',
      diff: 'DIFF',
      prDescription: 'Adds rate limiting to the public /api endpoints.',
    });
    const user = messages[1]!.content;
    expect(user).toContain('## PR description');
    expect(user).toContain('<untrusted source="pr-description">');
    expect(user).toContain('Adds rate limiting to the public /api endpoints.');
    expect(user.indexOf('## PR description')).toBeLessThan(user.indexOf('## Diff to review'));
    expect(assembly.pr_description).toContain('Adds rate limiting');
  });

  it('omits the section when prDescription is undefined or blank (no behaviour change)', () => {
    expect(userOf({ system: 'sys', diff: 'DIFF' })).not.toContain('## PR description');
    expect(assemblePrompt({ system: 'sys', diff: 'DIFF' }).assembly.pr_description ?? null).toBeNull();
    expect(userOf({ system: 'sys', diff: 'DIFF', prDescription: '   ' })).not.toContain(
      '## PR description',
    );
  });

  it('truncates a huge body to the 4k cap', () => {
    const { assembly } = assemblePrompt({
      system: 'sys',
      diff: 'D',
      prDescription: 'x'.repeat(10_000),
    });
    expect((assembly.pr_description as string).length).toBe(4000);
  });
});
