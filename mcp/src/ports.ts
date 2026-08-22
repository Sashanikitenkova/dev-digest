import { z } from 'zod';

/**
 * PORT ring — the interface the outer world implements.
 *
 * The schemas below are DELIBERATELY narrow: they cover only the fields this
 * package reads, and nothing else. They are NOT imported from
 * `@devdigest/shared` — that package is built on zod 3, and this one runs on
 * zod 4 (required by `@modelcontextprotocol/server`). Mixing the two would
 * break `registerTool`'s StandardSchema inference.
 *
 * Because zod strips unknown keys by default, parsing a full API DTO through a
 * narrow schema succeeds and simply drops everything we did not ask for. That
 * makes this package resilient to additive API changes and keeps the shaping
 * layer honest about what it is allowed to see.
 *
 * Nullability mirrors the server contracts exactly (verified against
 * `server/src/vendor/shared/contracts/*`) — where the contract says `.nullish()`
 * we say `.nullish()`, so a legitimate payload never fails to parse.
 */

/** `GET /agents` — subset of `contracts/knowledge.ts` `Agent`. */
export const ApiAgent = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  model: z.string(),
  enabled: z.boolean(),
});
export type ApiAgent = z.infer<typeof ApiAgent>;

/** `GET /repos` — subset of `contracts/platform.ts` `Repo`. */
export const ApiRepo = z.object({
  id: z.string(),
  full_name: z.string(),
});
export type ApiRepo = z.infer<typeof ApiRepo>;

/**
 * `GET /repos/:id/pulls` — subset of `contracts/platform.ts` `PrMeta`.
 * `id` is `.nullish()` on the contract; the resolver must guard it rather than
 * splice `undefined` into a URL path.
 */
export const ApiPrMeta = z.object({
  id: z.string().nullish(),
  number: z.number().int(),
  title: z.string(),
});
export type ApiPrMeta = z.infer<typeof ApiPrMeta>;

/** `POST /pulls/:id/review` — subset of `contracts/review-api.ts` `ReviewRunResponse`. */
export const ApiReviewRunTarget = z.object({
  run_id: z.string(),
  agent_id: z.string(),
  agent_name: z.string(),
});
export type ApiReviewRunTarget = z.infer<typeof ApiReviewRunTarget>;

export const ApiReviewRunResponse = z.object({
  pr_id: z.string(),
  runs: z.array(ApiReviewRunTarget),
});
export type ApiReviewRunResponse = z.infer<typeof ApiReviewRunResponse>;

/** `GET /pulls/:id/runs` — subset of `contracts/trace.ts` `RunSummary`. */
export const ApiRunSummary = z.object({
  run_id: z.string(),
  agent_id: z.string().nullable(),
  agent_name: z.string().nullable(),
  status: z.string().nullable(), // running | done | failed | cancelled
  error: z.string().nullable(),
});
export type ApiRunSummary = z.infer<typeof ApiRunSummary>;

/** Subset of `contracts/review-api.ts` `FindingRecord`. */
export const ApiFinding = z.object({
  severity: z.enum(['CRITICAL', 'WARNING', 'SUGGESTION']),
  category: z.enum(['bug', 'security', 'perf', 'style', 'test']),
  title: z.string(),
  file: z.string(),
  start_line: z.number().int(),
  end_line: z.number().int(),
  rationale: z.string(),
  suggestion: z.string().nullish(),
  confidence: z.number(),
});
export type ApiFinding = z.infer<typeof ApiFinding>;

/** `GET /pulls/:id/reviews` — subset of `contracts/review-api.ts` `ReviewRecord`. */
export const ApiReview = z.object({
  id: z.string(),
  agent_id: z.string().nullable(),
  run_id: z.string().nullable(),
  agent_name: z.string().nullish(),
  kind: z.enum(['summary', 'review']),
  verdict: z.string().nullable(),
  summary: z.string().nullable(),
  score: z.number().int().nullable(),
  findings: z.array(ApiFinding),
});
export type ApiReview = z.infer<typeof ApiReview>;

/** `GET /repos/:id/conventions` — subset of `contracts/knowledge.ts` `ConventionCandidate`. */
export const ApiConvention = z.object({
  category: z.string().nullish(),
  rule: z.string(),
  evidence_path: z.string(),
  evidence_line: z.number().int().nullish(),
  confidence: z.number(),
  status: z.enum(['pending', 'accepted', 'rejected']),
});
export type ApiConvention = z.infer<typeof ApiConvention>;

/**
 * `GET /pulls/:id/blast` — subset of `contracts/brief.ts` `BlastRadius`.
 *
 * Only the fields `shapeBlast` actually renders are declared. `index` is the
 * one that changes what the model is allowed to conclude: an empty map from a
 * `missing` index means "not indexed", not "nothing is affected", and the tool
 * must never let those collapse into the same answer.
 */
const AffectedEndpoint = z.object({
  endpoint: z.string(),
  /** 1 = a direct caller/importer declares it; 2 = one import hop further out. */
  depth: z.number().int(),
});

export const ApiBlast = z.object({
  blast: z.object({
    index: z.object({
      status: z.enum(['full', 'partial', 'missing', 'failed']),
      reason: z.string().nullish(),
      files_indexed: z.number().int().nullish(),
    }),
    changed_symbols: z.array(
      z.object({ name: z.string(), file: z.string(), kind: z.string() }),
    ),
    downstream: z.array(
      z.object({
        symbol: z.string(),
        callers: z.array(
          z.object({ name: z.string(), file: z.string(), line: z.number().int() }),
        ),
        caller_total: z.number().int().nullish(),
        endpoints_affected: z.array(AffectedEndpoint),
        crons_affected: z.array(AffectedEndpoint),
      }),
    ),
    impacted_endpoints: z.array(z.string()),
    impacted_crons: z.array(z.string()),
    summary: z.string(),
  }),
});
export type ApiBlast = z.infer<typeof ApiBlast>;

/**
 * The single port for the whole DevDigest HTTP API.
 *
 * One port, not one per resource: the onion skill's own caveat is not to
 * over-engineer small modules, and there is exactly one outbound system here.
 */
export interface DevDigestApi {
  /** Base URL this implementation talks to — used to build reachable error text. */
  readonly baseUrl: string;

  listAgents(): Promise<ApiAgent[]>;
  listRepos(): Promise<ApiRepo[]>;
  listPulls(repoId: string): Promise<ApiPrMeta[]>;
  startReview(pullId: string, agentId: string): Promise<ApiReviewRunResponse>;
  listRuns(pullId: string): Promise<ApiRunSummary[]>;
  listReviews(pullId: string): Promise<ApiReview[]>;
  listConventions(repoId: string): Promise<ApiConvention[]>;
  getBlast(pullId: string): Promise<ApiBlast>;
}

/**
 * What the application ring (`resolve.ts`, `tools/*`) depends on: the port plus
 * the studio's base URL, which several forward-leading error messages point the
 * user at. Both are resolved once in the composition root (`index.ts`) from
 * `DEVDIGEST_API_BASE` / `DEVDIGEST_WEB_BASE`.
 */
export interface ToolContext {
  readonly api: DevDigestApi;
  readonly webBaseUrl: string;
}
