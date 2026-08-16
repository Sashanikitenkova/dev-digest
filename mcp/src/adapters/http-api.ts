import { z } from 'zod';
import {
  ApiAgent,
  ApiConvention,
  ApiPrMeta,
  ApiRepo,
  ApiReview,
  ApiReviewRunResponse,
  ApiRunSummary,
  type DevDigestApi,
} from '../ports.js';
import { apiErrorResponse, apiUnexpectedShape, apiUnreachable, toolError } from '../errors.js';

/**
 * ADAPTER ring — the ONLY file in this package that calls `fetch`.
 *
 * Everything above it (tools, resolve) depends on the `DevDigestApi` port, which
 * is why the whole test suite runs against a plain stub object with no
 * `globalThis.fetch` monkey-patching anywhere.
 *
 * No auth header is sent: the API's `LocalNoAuthProvider` ignores the request
 * and resolves the single seeded workspace.
 */

/** The API's error envelope: `{ error: { code, message, details } }`. */
const ErrorEnvelope = z.object({
  error: z.object({
    code: z.string().optional(),
    message: z.string().optional(),
  }),
});

export interface HttpDevDigestApiOptions {
  /** Base URL of the DevDigest API, e.g. `http://localhost:3001`. */
  baseUrl: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export class HttpDevDigestApi implements DevDigestApi {
  readonly baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: HttpDevDigestApiOptions) {
    // Trailing slashes would produce `//agents`, which Fastify 404s.
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
  }

  listAgents(): Promise<z.infer<typeof ApiAgent>[]> {
    return this.#request('GET', '/agents', z.array(ApiAgent));
  }

  listRepos(): Promise<z.infer<typeof ApiRepo>[]> {
    return this.#request('GET', '/repos', z.array(ApiRepo));
  }

  listPulls(repoId: string): Promise<z.infer<typeof ApiPrMeta>[]> {
    return this.#request('GET', `/repos/${encodeURIComponent(repoId)}/pulls`, z.array(ApiPrMeta));
  }

  startReview(pullId: string, agentId: string): Promise<z.infer<typeof ApiReviewRunResponse>> {
    return this.#request('POST', `/pulls/${encodeURIComponent(pullId)}/review`, ApiReviewRunResponse, {
      agentId,
    });
  }

  listRuns(pullId: string): Promise<z.infer<typeof ApiRunSummary>[]> {
    return this.#request('GET', `/pulls/${encodeURIComponent(pullId)}/runs`, z.array(ApiRunSummary));
  }

  listReviews(pullId: string): Promise<z.infer<typeof ApiReview>[]> {
    return this.#request('GET', `/pulls/${encodeURIComponent(pullId)}/reviews`, z.array(ApiReview));
  }

  listConventions(repoId: string): Promise<z.infer<typeof ApiConvention>[]> {
    return this.#request(
      'GET',
      `/repos/${encodeURIComponent(repoId)}/conventions`,
      z.array(ApiConvention),
    );
  }

  async #request<T>(
    method: 'GET' | 'POST',
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.baseUrl}${path}`, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      // Connection refused / DNS / socket reset all land here. This is by far
      // the most likely failure, so it gets the most actionable message.
      throw toolError(apiUnreachable(this.baseUrl));
    }

    const raw: unknown = await response.text().then(parseJsonLoosely);

    if (!response.ok) {
      const envelope = ErrorEnvelope.safeParse(raw);
      const message = envelope.success
        ? (envelope.data.error.message ?? envelope.data.error.code ?? response.statusText)
        : response.statusText;
      throw toolError(apiErrorResponse(method, path, response.status, message));
    }

    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw toolError(
        apiUnexpectedShape(method, path, parsed.error.issues[0]?.message ?? 'validation failed'),
      );
    }
    return parsed.data;
  }
}

/** A non-JSON body (an HTML error page, an empty 204) must not throw raw. */
function parseJsonLoosely(text: string): unknown {
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
