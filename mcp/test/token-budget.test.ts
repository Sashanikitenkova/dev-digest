import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { getEncoding } from 'js-tiktoken';
import { beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../src/server.js';
import { stubContext } from './stub-api.js';

/**
 * PRESENTATION ring — asserted against the **actual wire payload**.
 *
 * Every MCP tool's name, description and JSON Schema is injected at session
 * start and re-sent on every turn, so a careless server taxes the whole
 * conversation. This test is the guard rail that keeps that cost from drifting:
 * it drives a real `InMemoryTransport` pair and a real `Client.listTools()`, so
 * what it measures is exactly what a host pays — including the JSON Schema that
 * each `outputSchema` compiles to, which is what doubled the first estimate.
 *
 * If this fails because the number grew, do NOT reword the descriptions to fit.
 * They are verbatim from the approved plan and were chosen for their effect on
 * tool-selection accuracy; the plan carries an ordered trim list instead.
 */

/** Enforced budget from the plan. Measured, not estimated. */
const TOTAL_TOKEN_BUDGET = 1_600;
const PER_TOOL_TOKEN_BUDGET = 450;

type WireTool = {
  name: string;
  description?: string;
  inputSchema?: { properties?: Record<string, { type?: string }> };
  outputSchema?: unknown;
  annotations?: Record<string, unknown>;
};

let tools: WireTool[];

beforeAll(async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const server = createServer(stubContext());
  const client = new Client({ name: 'token-budget-test', version: '0.0.0' });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  tools = (await client.listTools()).tools as unknown as WireTool[];
});

function tool(name: string): WireTool {
  const found = tools.find((t) => t.name === name);
  expect(found, `tool ${name} is not registered`).toBeDefined();
  return found!;
}

describe('the registered tool set', () => {
  it('is exactly the five workflow-level tools, not REST parity', () => {
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_blast_radius',
      'get_conventions',
      'get_findings',
      'list_agents',
      'run_agent_on_pr',
    ]);
  });

  it('uses unprefixed names — MCP hosts already namespace by server', () => {
    expect(tools.every((t) => !t.name.startsWith('devdigest'))).toBe(true);
  });

  it('describes every tool', () => {
    for (const t of tools) expect(t.description, t.name).toBeTruthy();
  });
});

describe('annotations', () => {
  it('marks the four reads readOnlyHint: true', () => {
    for (const name of ['list_agents', 'get_findings', 'get_conventions', 'get_blast_radius']) {
      expect(tool(name).annotations?.['readOnlyHint'], name).toBe(true);
    }
  });

  it('marks run_agent_on_pr as the one writing, non-idempotent, non-destructive tool', () => {
    const annotations = tool('run_agent_on_pr').annotations ?? {};
    expect(annotations['readOnlyHint']).not.toBe(true);
    expect(annotations['destructiveHint']).toBe(false);
    expect(annotations['idempotentHint']).toBe(false);
  });
});

describe('design principle #2 — flat arguments', () => {
  it('emits only scalar parameters: no nested objects, no arrays', () => {
    for (const t of tools) {
      const properties = t.inputSchema?.properties ?? {};
      for (const [field, schema] of Object.entries(properties)) {
        expect(schema.type, `${t.name}.${field}`).not.toBe('object');
        expect(schema.type, `${t.name}.${field}`).not.toBe('array');
      }
    }
  });
});

describe('the two free budget savings', () => {
  it('list_agents declares no inputSchema — it takes no arguments', () => {
    // An empty object schema still costs tokens; omitting the field costs none.
    const properties = tool('list_agents').inputSchema?.properties ?? {};
    expect(Object.keys(properties)).toEqual([]);
  });

  it('get_blast_radius declares no outputSchema — a stub message needs none', () => {
    expect(tool('get_blast_radius').outputSchema).toBeUndefined();
  });
});

describe('token budget', () => {
  const encoder = getEncoding('cl100k_base');
  const count = (value: unknown) => encoder.encode(JSON.stringify(value)).length;

  it('keeps the whole tools/list payload under budget', () => {
    const total = count(tools);
    // Printed so `npm test` output is the source for README.md's figure.
    console.error(`[token-budget] tools/list total: ${total} tokens (budget ${TOTAL_TOKEN_BUDGET})`);
    expect(total).toBeLessThanOrEqual(TOTAL_TOKEN_BUDGET);
  });

  it('keeps every individual tool under budget', () => {
    for (const t of tools) {
      const tokens = count(t);
      console.error(`[token-budget]   ${t.name}: ${tokens} tokens`);
      expect(tokens, t.name).toBeLessThanOrEqual(PER_TOOL_TOKEN_BUDGET);
    }
  });
});
