import type { ToolContext } from './ports.js';
import {
  agentAmbiguous,
  agentNotFound,
  pullHasNoId,
  pullNotFound,
  repoNotFound,
  toolError,
} from './errors.js';

/**
 * APPLICATION ring — `"acme/payments-api"` + `482` + `"Security Reviewer"` →
 * three UUIDs.
 *
 * This layer exists because the tools address things semantically. That is a
 * deliberate cost: semantic identifiers measurably beat opaque UUIDs for model
 * precision, and the agent avoids a discovery round-trip. It also means a
 * mistyped name fails HERE, with a forward-leading message, instead of reaching
 * the API — where a non-uuid `:id` param is rejected as a 422, not a 404.
 *
 * Depends on the port only; there is no `fetch` in this file.
 */

export interface ResolvedRepo {
  id: string;
  fullName: string;
}

export interface ResolvedAgent {
  id: string;
  name: string;
}

/**
 * Process-lifetime memoization. Repos and agents change rarely, so caching them
 * removes two round-trips from every `run_agent_on_pr` after the first.
 *
 * PR resolution is deliberately NOT cached — PRs are imported continuously, and
 * a cached miss would make a retry permanently impossible. For the same reason
 * only POSITIVE results land in these maps.
 */
const repoCache = new Map<string, ResolvedRepo>();
const agentCache = new Map<string, ResolvedAgent>();

/** Test-only seam. Nothing in `src/` calls this. */
export function resetResolverCache(): void {
  repoCache.clear();
  agentCache.clear();
}

/** `GET /repos`, matched on `full_name` case-insensitively. */
export async function resolveRepo(ctx: ToolContext, fullName: string): Promise<ResolvedRepo> {
  const key = fullName.trim().toLowerCase();
  const cached = repoCache.get(key);
  if (cached) return cached;

  const repos = await ctx.api.listRepos();
  const match = repos.find((r) => r.full_name.toLowerCase() === key);
  if (!match) {
    throw toolError(
      repoNotFound(
        fullName,
        repos.map((r) => r.full_name),
        ctx.webBaseUrl,
      ),
    );
  }

  const resolved: ResolvedRepo = { id: match.id, fullName: match.full_name };
  repoCache.set(key, resolved);
  return resolved;
}

/**
 * `GET /repos/:id/pulls`, matched on `number`.
 *
 * ⚠️ This is not a cheap read: with a GitHub token configured the route syncs
 * every PR from GitHub and backfills diff stats for up to 10 of them — seconds,
 * not milliseconds. There is no `GET /repos/:id/pulls/:number` to use instead.
 * That same sync is what makes resolution self-healing: a PR that was never
 * imported gets imported by the very call that looks for it.
 */
export async function resolvePull(
  ctx: ToolContext,
  repo: ResolvedRepo,
  number: number,
): Promise<string> {
  const pulls = await ctx.api.listPulls(repo.id);
  const match = pulls.find((p) => p.number === number);
  if (!match) throw toolError(pullNotFound(repo.fullName, number, ctx.webBaseUrl));

  // `PrMeta.id` is `.nullish()` on the contract — the list route reads from the
  // DB so it is populated in practice, but never splice `undefined` into a path.
  if (!match.id) throw toolError(pullHasNoId(repo.fullName, number, ctx.webBaseUrl));

  return match.id;
}

/**
 * `GET /agents` — exact `id` match first, then case-insensitive `name`, then a
 * unique case-insensitive prefix.
 *
 * ⚠️ `agents` has no unique index on `(workspace_id, name)`, so two agents can
 * legally share a name. An ambiguous match throws a message that names the
 * duplicates rather than silently taking the first.
 */
export async function resolveAgent(ctx: ToolContext, nameOrId: string): Promise<ResolvedAgent> {
  const query = nameOrId.trim();
  const key = query.toLowerCase();
  const cached = agentCache.get(key);
  if (cached) return cached;

  const agents = await ctx.api.listAgents();

  const byId = agents.find((a) => a.id === query);
  const candidates =
    byId !== undefined
      ? [byId]
      : pickFirstNonEmpty(
          agents.filter((a) => a.name.toLowerCase() === key),
          agents.filter((a) => a.name.toLowerCase().startsWith(key)),
        );

  if (candidates.length === 0) {
    throw toolError(
      agentNotFound(
        query,
        agents.map((a) => a.name),
      ),
    );
  }
  if (candidates.length > 1) {
    throw toolError(
      agentAmbiguous(
        query,
        candidates.map((a) => a.name),
      ),
    );
  }

  const only = candidates[0]!;
  const resolved: ResolvedAgent = { id: only.id, name: only.name };
  agentCache.set(key, resolved);
  return resolved;
}

function pickFirstNonEmpty<T>(...groups: T[][]): T[] {
  for (const group of groups) if (group.length > 0) return group;
  return [];
}
