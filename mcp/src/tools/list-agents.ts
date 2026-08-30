import type { ToolContext } from '../ports.js';
import { ok, shapeAgents, type ToolResult } from '../shape.js';

/**
 * APPLICATION ring — `list_agents`.
 *
 * The cheapest tool in the set, and the one the other tools' error messages
 * point at. It exists so `run_agent_on_pr` does not have to inline an enum of
 * agent names into its schema, which would cost context on every turn and go
 * stale the moment an agent is renamed.
 */
export async function listAgents(ctx: ToolContext): Promise<ToolResult> {
  const agents = await ctx.api.listAgents();
  return ok({ agents: shapeAgents(agents) });
}
