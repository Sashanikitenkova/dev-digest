import { describe, expect, it } from 'vitest';
import {
  agentAmbiguous,
  agentNotFound,
  apiErrorResponse,
  apiUnexpectedShape,
  apiUnreachable,
  BLAST_RADIUS_STUB_MESSAGE,
  DevDigestToolError,
  NO_CONVENTIONS_MESSAGE,
  noReviewYet,
  pullHasNoId,
  pullNotFound,
  repoNotFound,
  reviewDidNotStart,
  runEndedBadly,
  runProducedNoReview,
  STILL_RUNNING_MESSAGE,
  toolError,
  unexpectedFailure,
} from '../src/errors.js';

/**
 * DOMAIN ring — pure. These assert the EXACT text, because the message is the
 * product here: it is what the model reads and acts on. A reworded message is a
 * behaviour change, so it should break a test.
 */

describe('transport-level messages', () => {
  it('names the base URL and the command that fixes it', () => {
    expect(apiUnreachable('http://localhost:3001')).toBe(
      'DevDigest API is not reachable at http://localhost:3001 — start it with ./scripts/dev.sh',
    );
  });

  it('reports a structured API error with method, path and status', () => {
    expect(apiErrorResponse('GET', '/repos/x/pulls', 422, 'Invalid uuid')).toBe(
      'DevDigest API returned 422 for GET /repos/x/pulls: Invalid uuid',
    );
  });

  it('flags a body that did not match the narrow schema as a version mismatch', () => {
    expect(apiUnexpectedShape('GET', '/agents', 'Invalid input')).toBe(
      'DevDigest API returned an unexpected body for GET /agents: Invalid input. The API may be a different version than this MCP server expects.',
    );
  });
});

describe('resolution messages', () => {
  it('lists the known repositories when the requested one is missing', () => {
    expect(repoNotFound('acme/nope', ['acme/payments-api'], 'http://localhost:3000')).toBe(
      'Repository "acme/nope" is not imported into DevDigest. Import it from the DevDigest UI at http://localhost:3000 first, then retry. Repositories currently in DevDigest: acme/payments-api.',
    );
  });

  it('says so plainly when nothing has been imported at all', () => {
    expect(repoNotFound('acme/nope', [], 'http://localhost:3000')).toContain(
      'No repositories have been imported yet.',
    );
  });

  it('names GITHUB_TOKEN as the likely cause of a missing pull request', () => {
    expect(pullNotFound('acme/payments-api', 482, 'http://localhost:3000')).toBe(
      'Pull request #482 was not found in "acme/payments-api". DevDigest only sees pull requests it has imported — open the repository in the DevDigest UI at http://localhost:3000 to sync it, and check that GITHUB_TOKEN is configured so the sync can reach GitHub.',
    );
  });

  it('distinguishes a PR with no stored id from a missing PR', () => {
    expect(pullHasNoId('acme/payments-api', 482, 'http://localhost:3000')).toBe(
      'Pull request #482 in "acme/payments-api" has no stored id yet, so it cannot be reviewed. Open the repository in the DevDigest UI at http://localhost:3000 to finish importing it, then retry.',
    );
  });

  it('leads a missing agent forward to list_agents', () => {
    const message = agentNotFound('Securty', ['Security Reviewer', 'API Contract Reviewer']);
    expect(message).toBe(
      'agent not found — call list_agents. Nothing matched "Securty". Configured agents: Security Reviewer, API Contract Reviewer.',
    );
    expect(message.startsWith('agent not found — call list_agents')).toBe(true);
  });

  it('names the duplicates instead of silently picking one', () => {
    expect(agentAmbiguous('Review', ['Reviewer A', 'Reviewer B'])).toBe(
      'Agent name "Review" is ambiguous — it matches 2 agents: Reviewer A, Reviewer B. Call list_agents and pass a name that identifies exactly one, or pass the agent\'s id.',
    );
  });
});

describe('operational messages', () => {
  it('tells the agent how to make conventions exist', () => {
    expect(NO_CONVENTIONS_MESSAGE).toBe(
      'No conventions have been extracted for this repository yet. Run the conventions extractor from the DevDigest UI, or POST /repos/{id}/conventions/extract.',
    );
  });

  it('points the blast-radius homework at the endpoint that already works', () => {
    expect(BLAST_RADIUS_STUB_MESSAGE).toBe(
      'Blast radius is not wired up yet. The backend already implements it at GET /pulls/{id}/blast, which returns changed_symbols, downstream callers, impacted_endpoints, impacted_crons and prior-PR history.',
    );
  });

  it('points an empty review history at run_agent_on_pr', () => {
    expect(noReviewYet('acme/payments-api', 482)).toBe(
      'No completed review exists for #482 in "acme/payments-api" yet. Call run_agent_on_pr to produce one.',
    );
  });

  it('scopes the empty-review message to the requested agent', () => {
    expect(noReviewYet('acme/payments-api', 482, 'Security Reviewer')).toContain(
      'No completed review by agent "Security Reviewer" exists',
    );
  });

  it('hands a still-running review back with the next step', () => {
    expect(STILL_RUNNING_MESSAGE).toBe(
      'The review is still running after 5 minutes. Call get_findings with the same repo and pr to collect the result.',
    );
  });

  it('includes the run error when a run ends badly', () => {
    expect(runEndedBadly('failed', 'provider returned 401')).toBe(
      'The review run ended with status "failed". DevDigest reported: provider returned 401. Call list_agents to check the agent\'s provider and model, then retry run_agent_on_pr.',
    );
  });

  it('omits the reported-error clause when there is no error text', () => {
    expect(runEndedBadly('cancelled', null)).toBe(
      'The review run ended with status "cancelled". Call list_agents to check the agent\'s provider and model, then retry run_agent_on_pr.',
    );
  });

  it('covers a run that finished without persisting a review', () => {
    expect(runProducedNoReview('run-1')).toBe(
      'The review run run-1 finished but produced no stored review. Call get_findings for this pull request to see whether an earlier review exists.',
    );
  });

  it('covers an accepted request that started no run', () => {
    expect(reviewDidNotStart('Security Reviewer')).toBe(
      'DevDigest accepted the request but started no run for agent "Security Reviewer". Call list_agents to confirm the agent still exists, then retry.',
    );
  });

  it('wraps an unanticipated failure without leaking a stack trace', () => {
    expect(unexpectedFailure('get_findings', 'boom')).toBe(
      'get_findings failed unexpectedly: boom. Check that the DevDigest API is running and retry.',
    );
  });
});

describe('DevDigestToolError', () => {
  it('carries the message verbatim and is instanceof-checkable', () => {
    const error = toolError('anything');
    expect(error).toBeInstanceOf(DevDigestToolError);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('anything');
    expect(error.name).toBe('DevDigestToolError');
  });
});
