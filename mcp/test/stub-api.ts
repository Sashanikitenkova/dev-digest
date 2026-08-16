import type {
  ApiAgent,
  ApiConvention,
  ApiFinding,
  ApiPrMeta,
  ApiRepo,
  ApiReview,
  ApiReviewRunResponse,
  ApiRunSummary,
  DevDigestApi,
  ToolContext,
} from '../src/ports.js';

/**
 * The stub `DevDigestApi` every test in this package runs against.
 *
 * This file is the whole payoff of the port: there is no `fetch` mocking, no
 * `globalThis` patching, no API, no DB and no Docker anywhere in the suite. If
 * a test in this package ever needs a live dependency, a boundary has leaked.
 *
 * Not named `*.test.ts`, so vitest's `include` glob leaves it alone.
 */

export interface StubOptions {
  agents?: ApiAgent[];
  repos?: ApiRepo[];
  /** Keyed by repo id. */
  pulls?: Record<string, ApiPrMeta[]>;
  /** Keyed by pull id. */
  reviews?: Record<string, ApiReview[]>;
  /** Keyed by repo id. */
  conventions?: Record<string, ApiConvention[]>;
  /**
   * Successive responses for `listRuns`. The last entry repeats forever, so a
   * polling test can express "running, running, done" as three entries.
   */
  runSequence?: ApiRunSummary[][];
  startReview?: ApiReviewRunResponse;
}

export class StubApi implements DevDigestApi {
  readonly baseUrl = 'http://localhost:3001';

  /** Per-method call counts — how the caching assertions are made. */
  readonly calls = {
    listAgents: 0,
    listRepos: 0,
    listPulls: 0,
    startReview: 0,
    listRuns: 0,
    listReviews: 0,
    listConventions: 0,
  };

  readonly startReviewArgs: Array<{ pullId: string; agentId: string }> = [];

  #runPolls = 0;

  constructor(private readonly options: StubOptions = {}) {}

  async listAgents(): Promise<ApiAgent[]> {
    this.calls.listAgents += 1;
    return this.options.agents ?? [];
  }

  async listRepos(): Promise<ApiRepo[]> {
    this.calls.listRepos += 1;
    return this.options.repos ?? [];
  }

  async listPulls(repoId: string): Promise<ApiPrMeta[]> {
    this.calls.listPulls += 1;
    return this.options.pulls?.[repoId] ?? [];
  }

  async startReview(pullId: string, agentId: string): Promise<ApiReviewRunResponse> {
    this.calls.startReview += 1;
    this.startReviewArgs.push({ pullId, agentId });
    return (
      this.options.startReview ?? {
        pr_id: pullId,
        // `reviews` is always empty on this endpoint — the run is fire-and-forget.
        runs: [{ run_id: 'run-1', agent_id: agentId, agent_name: 'stub agent' }],
      }
    );
  }

  async listRuns(): Promise<ApiRunSummary[]> {
    this.calls.listRuns += 1;
    const sequence = this.options.runSequence ?? [[]];
    const index = Math.min(this.#runPolls, sequence.length - 1);
    this.#runPolls += 1;
    return sequence[index] ?? [];
  }

  async listReviews(pullId: string): Promise<ApiReview[]> {
    this.calls.listReviews += 1;
    return this.options.reviews?.[pullId] ?? [];
  }

  async listConventions(repoId: string): Promise<ApiConvention[]> {
    this.calls.listConventions += 1;
    return this.options.conventions?.[repoId] ?? [];
  }
}

export function stubContext(options: StubOptions = {}): ToolContext & { api: StubApi } {
  return { api: new StubApi(options), webBaseUrl: 'http://localhost:3000' };
}

// ---- Fixture builders -----------------------------------------------------

export function agent(overrides: Partial<ApiAgent> = {}): ApiAgent {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Security Reviewer',
    description: 'Finds security issues.',
    model: 'anthropic/claude-sonnet-4',
    enabled: true,
    ...overrides,
  };
}

export function repo(overrides: Partial<ApiRepo> = {}): ApiRepo {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    full_name: 'acme/payments-api',
    ...overrides,
  };
}

export function pull(overrides: Partial<ApiPrMeta> = {}): ApiPrMeta {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    number: 482,
    title: 'Add idempotency keys',
    ...overrides,
  };
}

export function finding(overrides: Partial<ApiFinding> = {}): ApiFinding {
  return {
    severity: 'WARNING',
    category: 'bug',
    title: 'Missing null check',
    file: 'src/pay.ts',
    start_line: 10,
    end_line: 12,
    rationale: 'A long markdown rationale that should not be returned by default.',
    suggestion: null,
    confidence: 0.8,
    ...overrides,
  };
}

export function review(overrides: Partial<ApiReview> = {}): ApiReview {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    agent_id: '11111111-1111-4111-8111-111111111111',
    run_id: 'run-1',
    agent_name: 'Security Reviewer',
    kind: 'review',
    verdict: 'request_changes',
    summary: 'Two issues worth fixing.',
    score: 62,
    findings: [],
    ...overrides,
  };
}

export function run(overrides: Partial<ApiRunSummary> = {}): ApiRunSummary {
  return {
    run_id: 'run-1',
    agent_id: '11111111-1111-4111-8111-111111111111',
    agent_name: 'Security Reviewer',
    status: 'running',
    error: null,
    ...overrides,
  };
}

export function convention(overrides: Partial<ApiConvention> = {}): ApiConvention {
  return {
    category: 'testing',
    rule: 'DB-backed tests are named *.it.test.ts',
    evidence_path: 'server/test/reviews.it.test.ts',
    evidence_line: 1,
    confidence: 0.9,
    status: 'accepted',
    ...overrides,
  };
}
