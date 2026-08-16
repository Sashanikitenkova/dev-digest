/**
 * DOMAIN ring — pure, zero I/O.
 *
 * Every message here obeys design principle #4: **errors lead forward**. The
 * model reads the message and knows what to do next, so a failure costs one
 * turn instead of ending the task. A bare "404" or "fetch failed" teaches it to
 * give up on a system that is merely misconfigured.
 *
 * These are plain string builders plus one error class. Nothing in this file
 * knows about HTTP, MCP, or the shape of a tool result.
 */

/**
 * An error whose `message` is already a forward-leading, model-readable
 * sentence. `server.ts` turns any of these into `isError: true` verbatim;
 * anything else gets a generic wrapper so an internal stack trace never leaks
 * into the model's context.
 */
export class DevDigestToolError extends Error {
  override readonly name = 'DevDigestToolError';
}

/** Throw helper — keeps call sites to one line. */
export function toolError(message: string): DevDigestToolError {
  return new DevDigestToolError(message);
}

// ---- Transport-level ------------------------------------------------------

/**
 * The single most likely failure in practice: the MCP server is up (the host
 * launched it) but the DevDigest API is not.
 */
export function apiUnreachable(baseUrl: string): string {
  return `DevDigest API is not reachable at ${baseUrl} — start it with ./scripts/dev.sh`;
}

/** A structured `{ error: { code, message, details } }` envelope came back. */
export function apiErrorResponse(
  method: string,
  path: string,
  status: number,
  message: string,
): string {
  return `DevDigest API returned ${status} for ${method} ${path}: ${message}`;
}

/** The body did not match even the narrow subset this package reads. */
export function apiUnexpectedShape(method: string, path: string, detail: string): string {
  return `DevDigest API returned an unexpected body for ${method} ${path}: ${detail}. The API may be a different version than this MCP server expects.`;
}

// ---- Resolution -----------------------------------------------------------

/**
 * `webBaseUrl` comes from `DEVDIGEST_WEB_BASE` — never hardcode :3000, because
 * the hermetic e2e stack runs the studio on alternate ports.
 */
export function repoNotFound(
  fullName: string,
  known: readonly string[],
  webBaseUrl: string,
): string {
  const suffix =
    known.length > 0
      ? ` Repositories currently in DevDigest: ${known.join(', ')}.`
      : ' No repositories have been imported yet.';
  return `Repository "${fullName}" is not imported into DevDigest. Import it from the DevDigest UI at ${webBaseUrl} first, then retry.${suffix}`;
}

export function pullNotFound(fullName: string, number: number, webBaseUrl: string): string {
  return `Pull request #${number} was not found in "${fullName}". DevDigest only sees pull requests it has imported — open the repository in the DevDigest UI at ${webBaseUrl} to sync it, and check that GITHUB_TOKEN is configured so the sync can reach GitHub.`;
}

/**
 * `PrMeta.id` is `.nullish()` on the contract, so a PR can legally come back
 * without a persisted id. Say so instead of splicing `undefined` into a path.
 */
export function pullHasNoId(fullName: string, number: number, webBaseUrl: string): string {
  return `Pull request #${number} in "${fullName}" has no stored id yet, so it cannot be reviewed. Open the repository in the DevDigest UI at ${webBaseUrl} to finish importing it, then retry.`;
}

export function agentNotFound(query: string, known: readonly string[]): string {
  const suffix =
    known.length > 0 ? ` Configured agents: ${known.join(', ')}.` : ' No agents are configured.';
  return `agent not found — call list_agents. Nothing matched "${query}".${suffix}`;
}

/**
 * `agents` has no unique index on `(workspace_id, name)`, so two agents can
 * share a name. Silently taking the first would make the tool non-deterministic.
 */
export function agentAmbiguous(query: string, matches: readonly string[]): string {
  return `Agent name "${query}" is ambiguous — it matches ${matches.length} agents: ${matches.join(', ')}. Call list_agents and pass a name that identifies exactly one, or pass the agent's id.`;
}

// ---- Operational (not errors — forward-leading empty/pending states) ------

/**
 * Convention rows are precomputed and never lazily extracted, so `[]` means
 * "never extracted", not "no conventions". Verbatim from the plan.
 */
export const NO_CONVENTIONS_MESSAGE =
  'No conventions have been extracted for this repository yet. Run the conventions extractor from the DevDigest UI, or POST /repos/{id}/conventions/extract.';

/** Verbatim from the plan — the `get_blast_radius` stub payload. */
export const BLAST_RADIUS_STUB_MESSAGE =
  'Blast radius is not wired up yet. The backend already implements it at GET /pulls/{id}/blast, which returns changed_symbols, downstream callers, impacted_endpoints, impacted_crons and prior-PR history.';

/** `get_findings` found no completed review — a healthy state, not a failure. */
export function noReviewYet(fullName: string, number: number, agent?: string): string {
  const scope = agent ? ` by agent "${agent}"` : '';
  return `No completed review${scope} exists for #${number} in "${fullName}" yet. Call run_agent_on_pr to produce one.`;
}

/** The run finished, but no review row carries its run_id. */
export function runProducedNoReview(runId: string): string {
  return `The review run ${runId} finished but produced no stored review. Call get_findings for this pull request to see whether an earlier review exists.`;
}

/** `POST /pulls/:id/review` came back with an empty `runs` array. */
export function reviewDidNotStart(agentName: string): string {
  return `DevDigest accepted the request but started no run for agent "${agentName}". Call list_agents to confirm the agent still exists, then retry.`;
}

/** The run failed or was cancelled. Reported as a result, not thrown. */
export function runEndedBadly(status: string, error: string | null): string {
  const detail = error ? ` DevDigest reported: ${error}.` : '';
  return `The review run ended with status "${status}".${detail} Call list_agents to check the agent's provider and model, then retry run_agent_on_pr.`;
}

/**
 * The 5-minute wait elapsed. Hand back a next step rather than hanging — runs
 * execute sequentially per agent and a 13m40s outlier is on record.
 */
export const STILL_RUNNING_MESSAGE =
  'The review is still running after 5 minutes. Call get_findings with the same repo and pr to collect the result.';

/** Anything we did not anticipate. Never leak a stack trace to the model. */
export function unexpectedFailure(toolName: string, detail: string): string {
  return `${toolName} failed unexpectedly: ${detail}. Check that the DevDigest API is running and retry.`;
}
