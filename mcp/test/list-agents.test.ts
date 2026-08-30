import { describe, expect, it } from 'vitest';
import type { ApiAgent } from '../src/ports.js';
import { listAgents } from '../src/tools/list-agents.js';
import { agent, stubContext } from './stub-api.js';

/**
 * APPLICATION ring — the two properties of `list_agents` that are budget- and
 * behaviour-critical, asserted over the WHOLE serialized result (both the
 * `content` text channel and `structuredContent`), not just one of them.
 *
 * A leak in either channel costs the same tokens.
 */

/** A realistic API payload: the real `Agent` DTO carries far more than we read. */
const SEEDED_PROMPT = 'You are a meticulous security reviewer. '.repeat(120);

function fullAgent(overrides: Partial<ApiAgent> = {}): ApiAgent {
  return {
    ...agent(overrides),
    // Fields the real endpoint returns that the narrow port schema omits.
    system_prompt: SEEDED_PROMPT,
    output_schema: { type: 'object' },
    version: 7,
    strategy: 'single-pass',
    ci_fail_on: 'critical',
    repo_intel: true,
    skills_count: 4,
  } as ApiAgent;
}

describe('list_agents — system_prompt containment', () => {
  it('never lets system_prompt reach the model, in any channel', async () => {
    const ctx = stubContext({ agents: [fullAgent(), fullAgent({ id: 'b', name: 'Second' })] });

    const result = await listAgents(ctx);
    const serialized = JSON.stringify(result);

    // A single seeded agent prompt runs to thousands of tokens; returning four
    // of them would blow the session budget on the very first call.
    expect(serialized).not.toContain('system_prompt');
    expect(serialized).not.toContain('meticulous security reviewer');
    expect(serialized.length).toBeLessThan(SEEDED_PROMPT.length);
  });

  it('drops every other non-decision field too', async () => {
    const ctx = stubContext({ agents: [fullAgent()] });
    const serialized = JSON.stringify(await listAgents(ctx));

    for (const field of [
      'output_schema',
      'version',
      'strategy',
      'ci_fail_on',
      'repo_intel',
      'skills_count',
    ]) {
      expect(serialized).not.toContain(field);
    }
  });

  it('returns name rather than id — the model passes it straight to run_agent_on_pr', async () => {
    const ctx = stubContext({ agents: [fullAgent()] });
    const result = await listAgents(ctx);
    const agents = result.structuredContent?.['agents'] as Array<Record<string, unknown>>;

    expect(Object.keys(agents[0]!)).toEqual(['name', 'description', 'model', 'enabled']);
    expect(JSON.stringify(result)).not.toContain('11111111-1111-4111-8111-111111111111');
  });
});

describe('list_agents — disabled agents', () => {
  it('returns disabled agents WITH the flag rather than hiding them', async () => {
    const ctx = stubContext({
      agents: [
        fullAgent({ name: 'On', enabled: true }),
        fullAgent({ id: 'off', name: 'Off', enabled: false }),
      ],
    });

    const agents = (await listAgents(ctx)).structuredContent?.['agents'] as Array<{
      name: string;
      enabled: boolean;
    }>;

    // `POST /pulls/:id/review` with an explicit agentId DOES run a disabled
    // agent — `resolveTargets` filters on `enabled` only in the `all: true`
    // branch. Hiding them would make a legal call look impossible.
    expect(agents.map((a) => a.name)).toEqual(['On', 'Off']);
    expect(agents.map((a) => a.enabled)).toEqual([true, false]);
  });
});
