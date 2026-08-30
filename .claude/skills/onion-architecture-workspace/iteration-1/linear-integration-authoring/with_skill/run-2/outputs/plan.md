# Implementation Plan — Linear ticket context on a pull request (server)

## Goal

When a PR's branch references a Linear issue (`feat/ENG-482-retry-budget`,
`oleksandra/eng-482-retry-budget`, …), the PR page shows that issue's **title**
and **current status**. This plan covers `server/` only — the endpoint, the
port, the adapter, the cache and the tests. The client change is listed as an
explicit follow-up at the end.

## Architecture — how this lands on the onion

Per `.claude/skills/onion-architecture/SKILL.md`, a new external provider is
introduced **port first**, then adapter, then composition root, then module:

| Ring | File | What it holds |
|---|---|---|
| Contracts (DTO) | `vendor/shared/contracts/tickets.ts` *(new)* | `PrTicket`, `PrTicketLookup` Zod schemas — the HTTP shape |
| Port | `vendor/shared/adapters.ts` *(edit)* | `IssueTrackerClient`, `TrackerIssue`, `TicketKey` |
| Infrastructure | `adapters/tickets/linear.ts` *(new)* | `LinearIssueTracker` — Linear GraphQL over `fetch`, behind `withRetry`/`withTimeout` |
| Infrastructure (test) | `adapters/mocks.ts` *(edit)* | `MockIssueTracker` |
| Composition root | `platform/container.ts` *(edit)* | `overrides.tickets`, `async tickets()`, secret-cache invalidation |
| Data access | `modules/tickets/repository.ts` *(new)* | the ONLY layer touching `pr_tickets` |
| Application | `modules/tickets/service.ts` *(new)* | parse → cache → fetch → persist → degrade |
| Domain (pure) | `modules/tickets/helpers.ts` *(new)* | branch-key parsing, freshness, row→DTO |
| Presentation | `modules/tickets/routes.ts` *(new)* | `GET /pulls/:id/ticket`, `POST /pulls/:id/ticket/refresh` |

Rules this respects, explicitly:

- **Port before adapter.** `IssueTrackerClient` is declared in
  `vendor/shared/adapters.ts` (the boundary file whose own doc comment says
  "ALL external calls go behind these interfaces") *before* any Linear code
  exists. `TicketService` names only that interface.
- **Only the composition root constructs the adapter.** `LinearIssueTracker`
  is imported by `platform/container.ts` and nothing else. `container.tickets()`
  is `async` and secret-resolving, exactly like `container.github()`.
- **All Drizzle for this domain lives in `repository.ts`.** The service never
  imports `db/schema.js`. (Note: `modules/pulls/routes.ts` queries Drizzle
  directly — that's pre-existing and out of scope; the new module does not
  copy it.)
- **Routes are presentation-only:** Zod `params` → one service call → response.
- **`reviewer-core` is untouched.** Ticket context is server-side page data, not
  review-prompt input. (If a later lesson wants the ticket in the prompt, the
  server resolves it to a plain object and passes it in as data — never a new
  network call from the core.)
- **Layering depth is proportionate** (`guides/pitfalls-and-tradeoffs.md`): one
  module, one table, one aggregate — a plain `repository.ts`, no
  facade-over-`repository/*.repo.ts` split.

## Key decisions

1. **A dedicated endpoint, not a field on `PrDetail`.** `GET /pulls/:id` already
   does a live GitHub round-trip plus five writes; hanging a second external
   provider off it makes the whole PR page wait on Linear. `GET
   /pulls/:id/ticket` loads independently and can fail on its own. It mirrors
   the shape `GET /pulls/:id/intent` already established.
2. **The response is an envelope, not a bare nullable ticket.** "No Linear key
   in the branch", "that key isn't a real issue", "no Linear API key
   configured", and "Linear is down" are four different empty states and the UI
   renders them differently. `PrTicketLookup = { state, key, ticket }` says
   which one it is; the route returns 200 for all of them (404 only for an
   unknown PR).
3. **`pr_tickets` is a cache, keyed by PR.** Local-first is a house rule
   (`pulls/routes.ts` serves persisted PRs when GitHub is unreachable). The
   ticket row lets the PR page render offline and stops every page load from
   hitting Linear. TTL: 10 min for a hit, 24 h for a miss.
4. **Misses are cached too.** A branch-name heuristic produces false positives
   (`chore/bump-node-20` → `NODE-20`). Without a negative cache each such PR
   re-queries Linear on every page view. `found = false` records "asked, no such
   issue" and is served as `not_found` until `TICKET_MISS_TTL_MS` expires.
5. **Both a state *name* and a state *type* are stored.** Linear workflow states
   are team-defined strings ("In Review", "Ready to ship"). The UI cannot colour
   those. Linear also exposes `state.type` from a fixed set
   (`triage|backlog|unstarted|started|completed|canceled`), so we persist both:
   `status` for display, `status_type` for styling. Unknown types normalize to
   `unknown` rather than throwing.
6. **The service never throws for a tracker failure.** Missing key → cached row
   if any, else `not_configured`. Network/GraphQL error → cached row marked
   `stale: true`, else `unavailable`. This matches the "degrade gracefully"
   convention `repo-intel` documents and `pulls` implements.
7. **Linear is looked up by `(team key, number)`, not by raw identifier
   string.** `issue(id:)` is documented for UUIDs; filtering
   `issues(filter: { team: { key: { eq } }, number: { eq } }, first: 1)` is the
   stable public shape and is exactly what the parsed branch key gives us.
8. **The key is a `SecretsProvider` secret (`LINEAR_API_KEY`), never
   `AppConfig`.** `platform/config.ts` says so in its own header comment.

## Steps

1. Add the DTO contract file + one barrel line (`vendor/shared` extends with new
   files; existing contract files are not rewritten).
2. Add the `IssueTrackerClient` port to `vendor/shared/adapters.ts`.
3. Write `adapters/tickets/linear.ts`; export it from `adapters/index.ts`.
4. Add `MockIssueTracker` to `adapters/mocks.ts`.
5. Wire `tickets` into `platform/container.ts` (override, getter, cache
   invalidation).
6. Add the `pr_tickets` table to `db/schema/pulls.ts` + the `db/schema.ts`
   barrel; generate migration `0017` (`pnpm db:generate` — pure additions, so no
   interactive rename prompt, cf. `server/INSIGHTS.md` 2026-07-20).
7. Write `modules/tickets/{constants,helpers,repository,service,routes}.ts` and
   register `tickets` in `modules/index.ts`.
8. Extend the settings connection test so the key can be entered in the existing
   API-keys UI (additive contract change only).
9. Tests: `test/tickets-helpers.test.ts` (pure) and `test/tickets.it.test.ts`
   (real Postgres, injected mock tracker).
10. Verify: `pnpm typecheck`, `pnpm exec vitest run --exclude '**/*.it.test.ts'`,
    `pnpm exec vitest run tickets.it.test`.

## Risks / notes

- **Branch-name heuristics are lossy.** `fix/UTF-8-encoding` parses as `UTF-8`.
  The negative cache absorbs it and the UI shows nothing; documented in
  `helpers.ts` and asserted in the helper test so the behaviour is deliberate.
- **Never let an un-injected provider fall through in tests.** `server/INSIGHTS.md`
  2026-08-11: a partially-injected container silently reaches
  `LocalSecretsProvider` and makes live billed calls. Every ticket test either
  injects `tickets` or injects a `secrets` stub that returns `undefined`.
- **`*.it.test.ts` naming is load-bearing** for the unit/integration split.
- **Migrations are not applied on boot** — `pnpm db:migrate` after pulling.

---

# Files

## `server/src/vendor/shared/contracts/tickets.ts` *(new)*

```ts
import { z } from 'zod';

/**
 * Issue-tracker ticket context for a pull request (SPEC — Linear, v1).
 *
 * The PR page shows the issue a branch references: its title and its CURRENT
 * status. Two status fields are carried deliberately —
 *   • `status` is the team-defined workflow-state NAME ("In Review", "Ready to
 *     ship"). It is what a human recognises, and it is an arbitrary string.
 *   • `status_type` is the tracker's own fixed CATEGORY for that state. It is
 *     what the UI can safely colour/sort on, because it is a closed set.
 * Collapsing them would force the client to pattern-match team-specific prose.
 */

/** Linear's `WorkflowState.type` values, plus a forward-compatible fallback. */
export const TicketStatusType = z.enum([
  'triage',
  'backlog',
  'unstarted',
  'started',
  'completed',
  'canceled',
  /** The tracker returned a type this version does not know. Never throws. */
  'unknown',
]);
export type TicketStatusType = z.infer<typeof TicketStatusType>;

export const PrTicket = z.object({
  /** Human key as the tracker spells it, e.g. `ENG-482`. */
  key: z.string(),
  title: z.string(),
  /** Team-defined state name, for display. */
  status: z.string(),
  /** Closed-set category for that state, for styling. */
  status_type: TicketStatusType,
  url: z.string(),
  source: z.literal('linear'),
  /** When this was last read FROM the tracker (not when it was read from us). */
  fetched_at: z.string(),
  /**
   * True when the tracker could not be reached and this is the last known
   * answer. The card stays useful offline, but must not claim to be current.
   */
  stale: z.boolean(),
});
export type PrTicket = z.infer<typeof PrTicket>;

/**
 * Why a PR has no ticket is as informative as the ticket itself, and the four
 * empty states render differently:
 *   ok              → `ticket` is populated
 *   no_reference    → the branch name carries no issue key (show nothing)
 *   not_found       → a key was parsed but the tracker has no such issue
 *   not_configured  → no LINEAR_API_KEY (show "Connect Linear" in settings)
 *   unavailable     → the tracker errored and we have nothing cached
 * A bare `PrTicket | null` would flatten all four into "no ticket".
 */
export const TicketLookupState = z.enum([
  'ok',
  'no_reference',
  'not_found',
  'not_configured',
  'unavailable',
]);
export type TicketLookupState = z.infer<typeof TicketLookupState>;

export const PrTicketLookup = z.object({
  state: TicketLookupState,
  /** The key parsed off the branch, when there was one — null for no_reference. */
  key: z.string().nullable(),
  ticket: PrTicket.nullable(),
});
export type PrTicketLookup = z.infer<typeof PrTicketLookup>;
```

## `server/src/vendor/shared/index.ts` *(edit — one added export)*

```ts
/**
 * @devdigest/shared — single source of truth for cross-package contracts.
 *
 * Exports (Zod schemas + inferred TS types):
 *  - contracts/findings   Review, Finding, Severity, Verdict, FindingAction, trifecta
 *  - contracts/brief      Intent, BlastRadius, Risks, PrHistory, SmartDiff, PrBrief
 *  - contracts/knowledge  Conformance, Onboarding, EvalRun/EvalCase, MemoryItem,
 *                         Skill/CommunitySkill, ConventionCandidate, Agent
 *  - contracts/trace      RunTrace, RunEvent, RunLogLine (single-document trace)
 *  - contracts/platform   Settings, ConnTestResult, Repo, PrMeta/PrDetail, SpecFile, …
 *  - contracts/tickets    PrTicket, PrTicketLookup (issue-tracker context on a PR)
 *  - adapters             adapter interfaces + ModelInfo
 *
 * Feature agents (A1–A6) and F2 import everything from here. The barrel is
 * stable — feature agents EXTEND with new files, they do not edit existing ones.
 */

export * from './contracts/findings.js';
export * from './contracts/review-api.js';
export * from './contracts/brief.js';
export * from './contracts/risk-brief.js';
export * from './contracts/knowledge.js';
export * from './contracts/trace.js';
export * from './contracts/platform.js';
export * from './contracts/tickets.js';
export * from './contracts/why.js';
export * from './contracts/eval-ci.js';
export * from './contracts/observability.js';
export * from './contracts/productionize.js';
export * from './adapters.js';
```

## `server/src/vendor/shared/adapters.ts` *(edit — append one section)*

Add the following block after the `// ---------- GitHub …` section (nothing
else in the file changes):

```ts
// ---------- Issue tracker (Linear; ticket context on a PR) ----------

/**
 * A parsed issue reference: the team key plus the per-team issue number.
 *
 * Two parts, not one string, because that is how the tracker is QUERIED
 * (`team.key eq "ENG"` AND `number eq 482`). `key` is the reassembled display
 * form and is what gets cached/echoed back — the caller never has to re-join it.
 */
export interface TicketKey {
  /** Uppercased team key, e.g. `ENG`. */
  team: string;
  /** Per-team issue number, e.g. `482`. */
  number: number;
  /** `${team}-${number}` — the canonical display key, e.g. `ENG-482`. */
  key: string;
}

export interface TrackerIssue {
  key: string;
  title: string;
  /** Team-defined workflow-state NAME, e.g. "In Review". */
  status: string;
  /**
   * The tracker's own state CATEGORY. A closed set the UI can style on, unlike
   * `status`. Adapters map anything unrecognised to `'unknown'` rather than
   * throwing — a new upstream state type must not break the PR page.
   */
  statusType:
    | 'triage'
    | 'backlog'
    | 'unstarted'
    | 'started'
    | 'completed'
    | 'canceled'
    | 'unknown';
  url: string;
}

/**
 * Issue tracker port. Linear is the only implementation today; the interface is
 * deliberately tracker-agnostic (no Linear ids, no GraphQL) so a Jira adapter
 * would slot in without touching the module that consumes it.
 *
 * `getIssue` distinguishes "no such issue" (resolves `null` — expected, because
 * the key came from a branch-name heuristic) from "the tracker failed"
 * (rejects). Callers treat those differently.
 */
export interface IssueTrackerClient {
  readonly id: 'linear';
  getIssue(key: TicketKey): Promise<TrackerIssue | null>;
  /** Display name of the authenticated principal — for the connection test. */
  currentUser(): Promise<string>;
}
```

Also extend the `SecretKey` union comment set (the type is already open-ended
via `(string & {})`, so `'LINEAR_API_KEY'` is added only for discoverability):

```ts
export type SecretKey =
  | 'OPENAI_API_KEY'
  | 'ANTHROPIC_API_KEY'
  | 'GITHUB_TOKEN'
  | 'LINEAR_API_KEY'
  | 'DATABASE_URL'
  | (string & {});
```

## `server/src/adapters/tickets/linear.ts` *(new)*

```ts
import type {
  IssueTrackerClient,
  TicketKey,
  TrackerIssue,
} from '@devdigest/shared';
import { ExternalServiceError } from '../../platform/errors.js';
import { withRetry, withTimeout } from '../../platform/resilience.js';

/**
 * IssueTrackerClient over Linear's GraphQL API — thin, `fetch`-only.
 *
 * No SDK: the two queries below are the entire surface we need, and adding
 * `@linear/sdk` would pull a generated client (and its own transport, retry and
 * error taxonomy) into the tree for that. `fetch` is global on Node ≥ 22.
 *
 * Lookup is by (team key, number) rather than by identifier string: `issue(id:)`
 * is specified for UUIDs, whereas the `issues(filter:)` shape below is the
 * documented way to resolve a human key and is exactly what a parsed branch
 * name yields.
 *
 * Auth: a personal API key is sent as the raw `Authorization` value (Linear's
 * documented form); an OAuth access token is sent as `Bearer <token>`.
 */

const ENDPOINT = 'https://api.linear.app/graphql';
const TIMEOUT = 15_000;

const ISSUE_QUERY = /* GraphQL */ `
  query DevDigestIssueByKey($team: String!, $number: Float!) {
    issues(
      filter: { team: { key: { eq: $team } }, number: { eq: $number } }
      first: 1
    ) {
      nodes {
        identifier
        title
        url
        state {
          name
          type
        }
      }
    }
  }
`;

const VIEWER_QUERY = /* GraphQL */ `
  query DevDigestViewer {
    viewer {
      name
      email
    }
  }
`;

interface LinearIssueNode {
  identifier: string;
  title: string;
  url: string;
  state: { name: string; type: string } | null;
}

/** Linear's closed set of workflow-state types. Anything else → 'unknown'. */
const STATE_TYPES = new Set<TrackerIssue['statusType']>([
  'triage',
  'backlog',
  'unstarted',
  'started',
  'completed',
  'canceled',
]);

function normalizeStateType(raw: string | undefined | null): TrackerIssue['statusType'] {
  const value = (raw ?? '').toLowerCase() as TrackerIssue['statusType'];
  return STATE_TYPES.has(value) ? value : 'unknown';
}

export class LinearIssueTracker implements IssueTrackerClient {
  readonly id = 'linear' as const;

  constructor(
    private readonly token: string,
    private readonly endpoint: string = ENDPOINT,
  ) {}

  private authorization(): string {
    // Personal API keys (`lin_api_…`) go through raw; OAuth tokens are bearer.
    return this.token.startsWith('lin_oauth_') ? `Bearer ${this.token}` : this.token;
  }

  private async query<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    return withRetry(() =>
      withTimeout(
        (async () => {
          const res = await fetch(this.endpoint, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: this.authorization(),
            },
            body: JSON.stringify({ query, variables }),
          });

          if (!res.ok) {
            // Attach `status` so resilience.withRetry's default predicate can
            // see a 429/5xx and back off; 4xx falls straight through.
            const err = Object.assign(
              new ExternalServiceError(`Linear API returned HTTP ${res.status}`),
              { status: res.status },
            );
            throw err;
          }

          const json = (await res.json()) as {
            data?: T;
            errors?: { message: string }[];
          };
          // GraphQL reports auth/validation failures as 200 + `errors`. These
          // are permanent, so they are NOT retried (no `status` attached).
          if (json.errors?.length) {
            throw new ExternalServiceError(
              `Linear API error: ${json.errors.map((e) => e.message).join('; ')}`,
            );
          }
          if (!json.data) throw new ExternalServiceError('Linear API returned no data');
          return json.data;
        })(),
        TIMEOUT,
      ),
    );
  }

  async getIssue(key: TicketKey): Promise<TrackerIssue | null> {
    const data = await this.query<{ issues: { nodes: LinearIssueNode[] } }>(ISSUE_QUERY, {
      team: key.team,
      number: key.number,
    });
    const node = data.issues.nodes[0];
    // Empty result = the key does not name an issue. Expected (branch names are
    // a heuristic), so it is a value, not an error.
    if (!node) return null;
    return {
      key: node.identifier,
      title: node.title,
      status: node.state?.name ?? 'Unknown',
      statusType: normalizeStateType(node.state?.type),
      url: node.url,
    };
  }

  async currentUser(): Promise<string> {
    const data = await this.query<{ viewer: { name: string; email: string } | null }>(
      VIEWER_QUERY,
      {},
    );
    return data.viewer?.name ?? data.viewer?.email ?? 'Linear';
  }
}
```

## `server/src/adapters/index.ts` *(edit — one added export)*

```ts
/** Adapter barrel — real + mock implementations behind the adapter interfaces. */
export { LocalSecretsProvider } from './secrets/local.js';
export { LocalNoAuthProvider } from './auth/local.js';
export { OpenAIProvider } from './llm/openai.js';
export { AnthropicProvider } from './llm/anthropic.js';
export { OpenAIEmbedder } from './embedder/openai.js';
export { OctokitGitHubClient } from './github/octokit.js';
export { SimpleGitClient } from './git/simple-git.js';
export { parseUnifiedDiff } from './git/diff-parser.js';
export { RipgrepCodeIndex } from './codeindex/ripgrep.js';
export { LinearIssueTracker } from './tickets/linear.js';
export { estimateCost } from './llm/pricing.js';
export * from './mocks.js';
```

## `server/src/adapters/mocks.ts` *(edit — add `MockIssueTracker`)*

Add `IssueTrackerClient`, `TicketKey` and `TrackerIssue` to the existing
`import type { … } from '@devdigest/shared';` block, then append:

```ts
// ---------- Mock issue tracker (Linear) ----------
export interface MockIssueTrackerOptions {
  /** Issues by display key, e.g. `{ 'ENG-482': { … } }`. Absent key ⇒ null. */
  issues?: Record<string, TrackerIssue>;
  user?: string;
  /** Simulate an unreachable tracker (every call rejects). */
  fail?: boolean;
}

/**
 * Deterministic IssueTrackerClient. `calls` is asserted on by the ticket tests
 * to prove the cache actually prevents a second lookup — a fetch count is the
 * only observable difference between "cached" and "re-fetched".
 */
export class MockIssueTracker implements IssueTrackerClient {
  readonly id = 'linear' as const;
  public calls: TicketKey[] = [];

  constructor(private opts: MockIssueTrackerOptions = {}) {}

  async getIssue(key: TicketKey): Promise<TrackerIssue | null> {
    this.calls.push(key);
    if (this.opts.fail) throw new Error('Linear unreachable (mock)');
    return this.opts.issues?.[key.key] ?? null;
  }

  async currentUser(): Promise<string> {
    if (this.opts.fail) throw new Error('Linear unreachable (mock)');
    return this.opts.user ?? 'Mock Linear User';
  }
}
```

## `server/src/platform/container.ts` *(edit — three additions)*

```ts
// 1) imports
import type {
  AuthProvider,
  SecretsProvider,
  GitHubClient,
  GitClient,
  CodeIndex,
  Embedder,
  LLMProvider,
  IssueTrackerClient,
} from '@devdigest/shared';
// …
import { LinearIssueTracker } from '../adapters/tickets/linear.js';
```

```ts
// 2) ContainerOverrides — one new field, next to `github`
export interface ContainerOverrides {
  secrets?: SecretsProvider;
  auth?: AuthProvider;
  github?: GitHubClient;
  git?: GitClient;
  /** Issue tracker (Linear) — tests inject a MockIssueTracker. */
  tickets?: IssueTrackerClient;
  codeIndex?: CodeIndex;
  embedder?: Embedder;
  /** Pre-built providers by id (skip key lookup). */
  llm?: Partial<Record<'openai' | 'anthropic' | 'openrouter', LLMProvider>>;
  /** repo-intel facade (T1.1+) — tests inject mock RepoIntel implementations. */
  repoIntel?: RepoIntel;
  /** repo-intel T3 adapters — only the indexer pipeline reads these. */
  depgraph?: DepGraph;
  tokenizer?: Tokenizer;
}
```

```ts
// 3) the field, the resolver, and cache invalidation (inside class Container)
  private _tickets?: IssueTrackerClient;

  /**
   * Issue tracker (Linear) for PR ticket context. Same lazy, secret-resolving
   * shape as `github()`: the key is read through SecretsProvider on first use
   * and the client is cached until `invalidateSecretCaches()`.
   *
   * Throws ConfigError when no key is configured. `TicketService` CATCHES that
   * and reports `not_configured` — an unconfigured tracker is a normal state of
   * a local-first install, not a failed request.
   */
  async tickets(): Promise<IssueTrackerClient> {
    if (this.overrides.tickets) return this.overrides.tickets;
    if (this._tickets) return this._tickets;
    const key = await this.secrets.get('LINEAR_API_KEY');
    if (!key) throw new ConfigError('LINEAR_API_KEY is not configured');
    this._tickets = new LinearIssueTracker(key);
    return this._tickets;
  }

  /**
   * Drop cached provider clients so the next resolve picks up changed secrets.
   * Call after persisting a new API key/PAT via SecretsProvider.set.
   */
  invalidateSecretCaches(): void {
    this.llmCache.clear();
    this._github = undefined;
    this._tickets = undefined;
    this._embedder = undefined;
  }
```

## `server/src/db/schema/pulls.ts` *(edit — add the `pr_tickets` table)*

```ts
import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { workspaces } from './core';
import { repos } from './repos';

// … pullRequests / prFiles / prCommits unchanged …

/**
 * Issue-tracker ticket context for a PR — a CACHE of the tracker's answer, not
 * a source of truth. One row per PR (the PK), so a branch rename simply
 * overwrites in place and the table never accumulates history.
 *
 * `found = false` is a NEGATIVE cache entry: a key was parsed off the branch and
 * the tracker was asked and had no such issue. It exists because branch-name
 * parsing is a heuristic — `chore/bump-node-20` yields `NODE-20` — and without
 * it every view of such a PR would re-query the tracker forever. Its TTL is much
 * longer than a hit's (see `modules/tickets/constants.ts`).
 *
 * `workspace_id` is carried per the tenancy rule in `db/schema.ts`, even though
 * `pr_id` already implies it, so the row can be scoped/reaped without a join.
 */
export const prTickets = pgTable(
  'pr_tickets',
  {
    prId: uuid('pr_id')
      .primaryKey()
      .references(() => pullRequests.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Display key parsed off the branch, uppercased, e.g. `ENG-482`. */
    ticketKey: text('ticket_key').notNull(),
    /** Which tracker answered. Only `linear` today. */
    source: text('source').notNull().default('linear'),
    /** false ⇒ negative cache entry; title/status/url are NULL. */
    found: boolean('found').notNull().default(true),
    title: text('title'),
    /** Team-defined state name, e.g. "In Review". */
    status: text('status'),
    /** Closed-set category for that state; see TicketStatusType. */
    statusType: text('status_type'),
    url: text('url'),
    /** When the TRACKER was last read — drives TTL and the `stale` flag. */
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    wsIdx: index('pr_tickets_ws_idx').on(t.workspaceId),
  }),
);
```

## `server/src/db/schema.ts` *(edit — barrel + schema object)*

Two edits inside the existing file:

```ts
import { pullRequests, prFiles, prCommits, prTickets } from './schema/pulls';
```

```ts
export const schema = {
  // …
  pullRequests,
  prFiles,
  prCommits,
  prTickets,
  // …
};
```

(The `export * from './schema/pulls';` line already re-exports `prTickets`.)

## `server/src/db/migrations/0017_wandering_ticket_master.sql` *(new)*

Generated with `pnpm db:generate` — pure additions (one new table), so it will
not hit the interactive rename prompt described in `server/INSIGHTS.md`
(2026-07-20). The generator also writes `meta/_journal.json` and
`meta/0017_snapshot.json`; do not hand-edit those. Expected SQL:

```sql
CREATE TABLE "pr_tickets" (
	"pr_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"ticket_key" text NOT NULL,
	"source" text DEFAULT 'linear' NOT NULL,
	"found" boolean DEFAULT true NOT NULL,
	"title" text,
	"status" text,
	"status_type" text,
	"url" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pr_tickets" ADD CONSTRAINT "pr_tickets_pr_id_pull_requests_id_fk" FOREIGN KEY ("pr_id") REFERENCES "public"."pull_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_tickets" ADD CONSTRAINT "pr_tickets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pr_tickets_ws_idx" ON "pr_tickets" USING btree ("workspace_id");
```

## `server/src/modules/tickets/constants.ts` *(new)*

```ts
/**
 * Tunables for PR ticket context.
 *
 * Everything here bounds how often an external tracker is asked about a PR that
 * a user may reload many times a minute, and how much tracker-controlled text
 * is persisted.
 */

/**
 * How long a SUCCESSFUL lookup is served from the cache. A ticket's status is
 * the field that moves ("In Progress" → "In Review"), so this is short enough
 * that the PR page is not lying for long, and long enough that a page reload
 * loop does not become a Linear rate-limit problem.
 */
export const TICKET_TTL_MS = 10 * 60_000;

/**
 * How long a MISS is served from the cache. Much longer than a hit: a branch key
 * that resolves to nothing is nearly always a parser false positive
 * (`chore/bump-node-20` → `NODE-20`), and that answer does not change. A real
 * issue created after the fact is picked up by the explicit refresh route.
 */
export const TICKET_MISS_TTL_MS = 24 * 60 * 60_000;

/**
 * Branch-name issue reference. Matched anywhere in the branch, at a
 * non-alphanumeric boundary, so all of these resolve to ENG-482:
 *   feat/ENG-482-retry-budget
 *   oleksandra/eng-482-retry-budget   (Linear's own default branch format)
 *   ENG-482
 * The team key must START with a letter, which is what keeps date-like branches
 * (`release/2024-05-01`) from matching. Linear team keys are 1–5 characters; we
 * require 2–5 because one-letter keys are rare and matching them turns every
 * `v-2`-shaped fragment into a tracker lookup.
 */
export const TICKET_KEY_RE = /(?:^|[^A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,4})-(\d{1,5})(?![0-9])/;

/** Cap on a persisted ticket title (tracker-controlled text). */
export const MAX_TITLE_CHARS = 300;

/** Cap on a persisted state name (tracker-controlled text). */
export const MAX_STATUS_CHARS = 80;
```

## `server/src/modules/tickets/helpers.ts` *(new)*

```ts
import type {
  PrTicket,
  PrTicketLookup,
  TicketKey,
  TicketStatusType,
} from '@devdigest/shared';
import type { PrTicketRow } from './repository.js';
import {
  MAX_STATUS_CHARS,
  MAX_TITLE_CHARS,
  TICKET_KEY_RE,
  TICKET_MISS_TTL_MS,
  TICKET_TTL_MS,
} from './constants.js';

/**
 * Pure helpers for PR ticket context: what counts as an issue reference, when a
 * cached answer is still usable, and how a row becomes the wire DTO.
 *
 * No I/O and no container, so each rule is unit-testable on its own — which
 * matters most for `parseTicketKey`, whose false-positive behaviour is a
 * deliberate, asserted trade-off rather than an accident.
 */

const KNOWN_STATUS_TYPES = new Set<TicketStatusType>([
  'triage',
  'backlog',
  'unstarted',
  'started',
  'completed',
  'canceled',
]);

/**
 * Extract the FIRST issue reference from a branch name, or `null`.
 *
 * First match (not last) because Linear's own branch format prefixes the author
 * (`oleksandra/eng-482-…`) and any later match is a mention, not the subject.
 *
 * This is a heuristic and it over-matches by design: `chore/bump-node-20` parses
 * as `NODE-20`. The alternative — an allowlist of team keys — would need
 * configuration before the feature worked at all. Over-matching costs one
 * tracker lookup whose miss is then cached for `TICKET_MISS_TTL_MS`, and the UI
 * shows nothing. Under-matching would silently hide real tickets.
 */
export function parseTicketKey(branch: string): TicketKey | null {
  const m = TICKET_KEY_RE.exec(branch);
  if (!m) return null;
  const team = m[1]!.toUpperCase();
  const number = Number(m[2]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return { team, number, key: `${team}-${number}` };
}

/** Trim + hard-cap a tracker-controlled string before it is persisted. */
export function clamp(value: string | null | undefined, max: number): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

export const clampTitle = (v: string | null | undefined) => clamp(v, MAX_TITLE_CHARS);
export const clampStatus = (v: string | null | undefined) => clamp(v, MAX_STATUS_CHARS);

/** Widen a persisted `status_type` string back to the contract enum. */
export function toStatusType(raw: string | null): TicketStatusType {
  return KNOWN_STATUS_TYPES.has(raw as TicketStatusType) ? (raw as TicketStatusType) : 'unknown';
}

/**
 * Is a cached row still worth serving without asking the tracker?
 *
 * Hits and misses get different budgets: a status changes, a false-positive key
 * does not. A row for a DIFFERENT key than the branch now carries is never
 * fresh — the caller checks that before getting here.
 */
export function isFresh(row: PrTicketRow, now: number): boolean {
  const ttl = row.found ? TICKET_TTL_MS : TICKET_MISS_TTL_MS;
  return now - row.fetchedAt.getTime() < ttl;
}

/**
 * Row → wire envelope. A `found: false` row is a real, cached answer, so it
 * reports `not_found` with the key — not `no_reference`, which means the branch
 * never mentioned an issue at all.
 */
export function toLookup(row: PrTicketRow, opts: { stale: boolean }): PrTicketLookup {
  if (!row.found) {
    return { state: 'not_found', key: row.ticketKey, ticket: null };
  }
  const ticket: PrTicket = {
    key: row.ticketKey,
    title: row.title ?? row.ticketKey,
    status: row.status ?? 'Unknown',
    status_type: toStatusType(row.statusType),
    url: row.url ?? '',
    source: 'linear',
    fetched_at: row.fetchedAt.toISOString(),
    stale: opts.stale,
  };
  return { state: 'ok', key: row.ticketKey, ticket };
}
```

## `server/src/modules/tickets/repository.ts` *(new)*

```ts
import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';
import type { PullRow } from '../../db/rows.js';

/**
 * Ticket data-access. The ONLY layer touching `pr_tickets`.
 *
 * It also reads the PR row directly — the same house rule the intent and
 * conventions repositories follow: a module never reaches into another module's
 * folder, and a plain workspace-scoped row read is not another module's
 * business logic.
 */

export type PrTicketRow = typeof t.prTickets.$inferSelect;

/** Everything one lookup writes. `prId` is the conflict target (the PK). */
export interface UpsertTicket {
  prId: string;
  workspaceId: string;
  ticketKey: string;
  found: boolean;
  title: string | null;
  status: string | null;
  statusType: string | null;
  url: string | null;
}

export class TicketRepository {
  constructor(private db: Db) {}

  /**
   * Workspace-scoped PR guard: the PR row, or `undefined` when it does not
   * exist IN THIS WORKSPACE (the service turns that into a 404 — never a
   * cross-tenant read).
   */
  async getPull(workspaceId: string, prId: string): Promise<PullRow | undefined> {
    const [row] = await this.db
      .select()
      .from(t.pullRequests)
      .where(and(eq(t.pullRequests.workspaceId, workspaceId), eq(t.pullRequests.id, prId)));
    return row;
  }

  async getByPr(prId: string): Promise<PrTicketRow | undefined> {
    const [row] = await this.db.select().from(t.prTickets).where(eq(t.prTickets.prId, prId));
    return row;
  }

  /**
   * One row per PR: a re-fetch (TTL expiry, an explicit refresh, or a branch
   * rename pointing at a different key) overwrites in place. `fetchedAt` is
   * bumped explicitly because the column default only applies on insert — the
   * same reason `pr_intent.generated_at` is set by hand.
   */
  async upsert(values: UpsertTicket): Promise<PrTicketRow> {
    const set = {
      workspaceId: values.workspaceId,
      ticketKey: values.ticketKey,
      source: 'linear',
      found: values.found,
      title: values.title,
      status: values.status,
      statusType: values.statusType,
      url: values.url,
      fetchedAt: new Date(),
    };
    const [row] = await this.db
      .insert(t.prTickets)
      .values({ prId: values.prId, ...set })
      .onConflictDoUpdate({ target: t.prTickets.prId, set })
      .returning();
    return row!;
  }

  /** Drop a PR's cached ticket — used when its branch no longer references one. */
  async clear(prId: string): Promise<void> {
    await this.db.delete(t.prTickets).where(eq(t.prTickets.prId, prId));
  }
}
```

## `server/src/modules/tickets/service.ts` *(new)*

```ts
import type { IssueTrackerClient, PrTicketLookup, TicketKey } from '@devdigest/shared';
import type { Container } from '../../platform/container.js';
import { NotFoundError } from '../../platform/errors.js';
import { TicketRepository, type PrTicketRow } from './repository.js';
import {
  clampStatus,
  clampTitle,
  isFresh,
  parseTicketKey,
  toLookup,
} from './helpers.js';

/**
 * PR ticket context — the issue a branch name references.
 *
 * The pipeline is: branch → parsed key → cached row (if fresh) → tracker →
 * persist → DTO. Two properties are the point of the module:
 *
 *   1. IT NEVER FAILS THE PR PAGE. A missing API key, an unreachable tracker
 *      and a key that names no issue are all NORMAL states of a local-first
 *      install, so each is reported as a lookup `state`, not an exception. The
 *      only throw is a genuine caller error: a PR that does not exist in this
 *      workspace. Same convention `pulls/routes.ts` uses for GitHub.
 *   2. IT NEVER LIES ABOUT FRESHNESS. When the tracker is unreachable but a
 *      cached row exists, the row is served with `stale: true` rather than
 *      silently presented as current.
 *
 * It talks to `IssueTrackerClient` through the container — it never imports
 * `adapters/tickets/linear.ts`, so tests inject `MockIssueTracker` and no test
 * can reach the network.
 */

/** Minimal structured-log sink, satisfied by Fastify's `req.log.warn`. */
export type TicketLogger = (obj: Record<string, unknown>, msg: string) => void;

export class TicketService {
  private repo: TicketRepository;

  constructor(private container: Container) {
    this.repo = new TicketRepository(container.db);
  }

  /**
   * Ticket context for a PR.
   *
   * @param force skip the cache TTL and re-ask the tracker (the refresh route).
   */
  async get(
    workspaceId: string,
    prId: string,
    opts: { force?: boolean } = {},
    log?: TicketLogger,
  ): Promise<PrTicketLookup> {
    const pull = await this.repo.getPull(workspaceId, prId);
    if (!pull) throw new NotFoundError('Pull request not found');

    const key = parseTicketKey(pull.branch);
    if (!key) {
      // The branch was renamed away from a ticket — drop the stale row so the
      // cache never outlives the reference that created it.
      await this.repo.clear(prId);
      return { state: 'no_reference', key: null, ticket: null };
    }

    // A cached row for a DIFFERENT key (branch renamed between tickets) is not
    // usable as either a fresh answer or a stale fallback.
    const cached = await this.repo.getByPr(prId);
    const usable: PrTicketRow | undefined =
      cached && cached.ticketKey === key.key ? cached : undefined;

    if (!opts.force && usable && isFresh(usable, Date.now())) {
      return toLookup(usable, { stale: false });
    }

    let tracker: IssueTrackerClient;
    try {
      tracker = await this.container.tickets();
    } catch (err) {
      // No LINEAR_API_KEY. An install that WAS configured keeps showing what it
      // learned, flagged stale; one that never was gets the "connect Linear"
      // state instead of an error.
      log?.({ err }, 'issue tracker not configured; serving cached ticket context');
      return usable
        ? toLookup(usable, { stale: true })
        : { state: 'not_configured', key: key.key, ticket: null };
    }

    try {
      const issue = await tracker.getIssue(key);
      const row = await this.persist(workspaceId, prId, key, issue);
      return toLookup(row, { stale: false });
    } catch (err) {
      log?.({ err, key: key.key }, 'issue tracker lookup failed; serving cached ticket context');
      return usable
        ? toLookup(usable, { stale: true })
        : { state: 'unavailable', key: key.key, ticket: null };
    }
  }

  /**
   * Persist the tracker's answer — including a MISS, as a negative cache entry.
   * Titles and state names are tracker-controlled text, so both are clamped
   * before they reach the database.
   */
  private async persist(
    workspaceId: string,
    prId: string,
    key: TicketKey,
    issue: Awaited<ReturnType<IssueTrackerClient['getIssue']>>,
  ): Promise<PrTicketRow> {
    if (!issue) {
      return this.repo.upsert({
        prId,
        workspaceId,
        ticketKey: key.key,
        found: false,
        title: null,
        status: null,
        statusType: null,
        url: null,
      });
    }
    return this.repo.upsert({
      prId,
      workspaceId,
      // The tracker's own spelling of the key wins over ours.
      ticketKey: issue.key || key.key,
      found: true,
      title: clampTitle(issue.title),
      status: clampStatus(issue.status),
      statusType: issue.statusType,
      url: issue.url,
    });
  }
}
```

## `server/src/modules/tickets/routes.ts` *(new)*

```ts
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { PrTicketLookup } from '@devdigest/shared';
import { getContext } from '../_shared/context.js';
import { IdParams } from '../_shared/schemas.js';
import { TicketService } from './service.js';

/**
 * Tickets module — issue-tracker context for a PR (Linear, v1).
 *   GET  /pulls/:id/ticket         → the referenced issue's title + status
 *   POST /pulls/:id/ticket/refresh → same, bypassing the cache TTL
 *
 * This is a SEPARATE endpoint rather than a field on `GET /pulls/:id` on
 * purpose: PR detail already makes a live GitHub round-trip plus several
 * writes, and hanging a second external provider off it would make the whole
 * page wait on Linear. The card loads (and fails) on its own.
 *
 * GET returns 200 with a `state` for every empty case — no reference in the
 * branch, no such issue, no API key, tracker down — so the UI renders four
 * distinguishable empty states instead of an error. 404 is reserved for a PR
 * that does not exist in this workspace.
 */
export default async function ticketsRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const service = new TicketService(app.container);

  app.get(
    '/pulls/:id/ticket',
    { schema: { params: IdParams } },
    async (req): Promise<PrTicketLookup> => {
      const { workspaceId } = await getContext(app.container, req);
      return service.get(workspaceId, req.params.id, {}, req.log.warn.bind(req.log));
    },
  );

  app.post(
    '/pulls/:id/ticket/refresh',
    {
      // No body schema: refresh takes no arguments, and declaring even an
      // OPTIONAL body would make a body-less POST trip Fastify's "Body cannot
      // be empty" check (see server/INSIGHTS.md, 2026-08-11).
      schema: { params: IdParams },
      // One external call per hit — same tight budget as intent detection.
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (req): Promise<PrTicketLookup> => {
      const { workspaceId } = await getContext(app.container, req);
      return service.get(workspaceId, req.params.id, { force: true }, req.log.warn.bind(req.log));
    },
  );
}
```

## `server/src/modules/index.ts` *(edit — one import + one entry)*

```ts
import type { FastifyPluginAsync } from 'fastify';
import settings from './settings/routes.js';
import repos from './repos/routes.js';
import pulls from './pulls/routes.js';
import polling from './polling/routes.js';
import workspace from './workspace/routes.js';
import agents from './agents/routes.js';
import skills from './skills/routes.js';
import reviews from './reviews/routes.js';
import repoIntel from './repo-intel/routes.js';
import conventions from './conventions/routes.js';
import context from './context/routes.js';
import intent from './intent/routes.js';
import blast from './blast/routes.js';
import brief from './brief/routes.js';
import risks from './risks/routes.js';
import smartDiff from './smart-diff/routes.js';
import tickets from './tickets/routes.js';

/**
 * Module registry. Each feature module is a Fastify plugin in
 * `modules/<name>/routes.ts`. Registered here in one place.
 *
 * ADD A MODULE: create `modules/<name>/routes.ts` exporting a default Fastify
 * plugin, then add one import + one entry below. (We register statically rather
 * than via filesystem autoload so the same code path works under tsx, the
 * bundler, and vitest — native dynamic import() of .ts files is not portable.)
 *
 * This is the Part-0 starter set. Each course lesson adds its own module here
 * (skills, intent/smart-diff, blast, brief/context/onboarding, eval/ci/hooks,
 * memory, plugins, …) without touching any other module or the shared schema.
 */
export const modules: Record<string, FastifyPluginAsync> = {
  settings,
  repos,
  pulls,
  polling,
  workspace,
  agents,
  skills,
  reviews,
  repoIntel,
  conventions,
  context,
  intent,
  blast,
  brief,
  risks,
  smartDiff,
  tickets,
};
```

## `server/src/modules/settings/constants.ts` *(edit)*

```ts
/** Constants for the settings module. */
import type { ConnTestProvider, SecretKey } from '@devdigest/shared';

/** Provider id used by the GitHub connection test branch. */
export const GITHUB_PROVIDER = 'github';

/** Provider id used by the Linear (issue tracker) connection test branch. */
export const LINEAR_PROVIDER = 'linear';

/** Maps a connection-test provider to the SecretsProvider key it persists to. */
export const SECRET_KEY_BY_PROVIDER: Record<ConnTestProvider, SecretKey> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  github: 'GITHUB_TOKEN',
  linear: 'LINEAR_API_KEY',
};
```

## `server/src/modules/settings/routes.ts` *(edit — one import + one branch)*

```ts
import { GITHUB_PROVIDER, LINEAR_PROVIDER, SECRET_KEY_BY_PROVIDER } from './constants.js';
```

and inside the `POST /settings/test-connection` handler, immediately after the
existing GitHub branch:

```ts
      if (provider === GITHUB_PROVIDER) {
        const gh = await container.github();
        const login = await gh.currentLogin();
        return { provider, ok: true, message: `Connected as @${login}` };
      }
      // Linear is not an LLM provider, so it cannot fall through to
      // `container.llm(provider)` below — it gets its own cheap `viewer` call.
      if (provider === LINEAR_PROVIDER) {
        const tracker = await container.tickets();
        const who = await tracker.currentUser();
        return { provider, ok: true, message: `Connected as ${who}` };
      }
      const llm = await container.llm(provider);
```

## `server/src/vendor/shared/contracts/platform.ts` *(edit — two additive changes)*

Both are backward-compatible: widening an enum accepts strictly more input, and
the new `SecretsStatus` field is optional so the client's vendored copy keeps
type-checking until it is resynced.

```ts
// ---- Connection test ----
export const ConnTestProvider = z.enum(['openai', 'anthropic', 'openrouter', 'github', 'linear']);
export type ConnTestProvider = z.infer<typeof ConnTestProvider>;
```

```ts
// ---- Secrets status (which provider keys are configured; never the values) ----
/** Boolean per provider: true ⇒ a key/PAT is stored. The value is never exposed. */
export const SecretsStatus = z.object({
  openai: z.boolean(),
  anthropic: z.boolean(),
  openrouter: z.boolean(),
  github: z.boolean(),
  /** Optional so an older vendored copy of this contract still parses/types. */
  linear: z.boolean().optional(),
});
export type SecretsStatus = z.infer<typeof SecretsStatus>;
```

## `server/test/tickets-helpers.test.ts` *(new)*

```ts
import { describe, it, expect } from 'vitest';
import {
  clampTitle,
  isFresh,
  parseTicketKey,
  toLookup,
  toStatusType,
} from '../src/modules/tickets/helpers.js';
import type { PrTicketRow } from '../src/modules/tickets/repository.js';
import { TICKET_MISS_TTL_MS, TICKET_TTL_MS } from '../src/modules/tickets/constants.js';

/**
 * Pure-helper tests for PR ticket context.
 *
 * `parseTicketKey` is the one place a branch name becomes an external lookup,
 * so its OVER-matching is asserted as deliberate behaviour rather than left as
 * an accident: the last case here documents that `chore/bump-node-20` really
 * does produce NODE-20, and why that is safe (the miss is cached).
 */

describe('parseTicketKey', () => {
  it('reads an uppercase key out of a conventional branch name', () => {
    expect(parseTicketKey('feat/ENG-482-retry-budget')).toEqual({
      team: 'ENG',
      number: 482,
      key: 'ENG-482',
    });
  });

  it("uppercases Linear's own lowercase branch format", () => {
    expect(parseTicketKey('oleksandra/eng-482-retry-budget')?.key).toBe('ENG-482');
  });

  it('matches a bare key', () => {
    expect(parseTicketKey('ENG-482')?.key).toBe('ENG-482');
  });

  it('takes the FIRST reference when a branch names two', () => {
    expect(parseTicketKey('feat/ENG-482-and-DES-91')?.key).toBe('ENG-482');
  });

  it('returns null when there is no reference', () => {
    expect(parseTicketKey('main')).toBeNull();
    expect(parseTicketKey('fix/rate-limit')).toBeNull();
    expect(parseTicketKey('chore/deps')).toBeNull();
  });

  it('does not match a date-shaped branch (team key must start with a letter)', () => {
    expect(parseTicketKey('release/2024-05-01')).toBeNull();
  });

  it('requires a boundary before the key', () => {
    expect(parseTicketKey('featENG-482')).toBeNull();
  });

  it('over-matches a hyphenated word+number — cached as a miss, by design', () => {
    // Documented trade-off: one tracker lookup, negatively cached for 24h.
    expect(parseTicketKey('chore/bump-node-20')?.key).toBe('NODE-20');
  });
});

describe('isFresh — hits and misses get different budgets', () => {
  const row = (found: boolean, ageMs: number): PrTicketRow =>
    ({
      prId: 'p',
      workspaceId: 'w',
      ticketKey: 'ENG-482',
      source: 'linear',
      found,
      title: found ? 'Retry budget' : null,
      status: found ? 'In Review' : null,
      statusType: found ? 'started' : null,
      url: found ? 'https://linear.app/acme/issue/ENG-482' : null,
      fetchedAt: new Date(Date.now() - ageMs),
    }) as PrTicketRow;

  it('serves a recent hit from cache', () => {
    expect(isFresh(row(true, TICKET_TTL_MS - 1_000), Date.now())).toBe(true);
  });

  it('re-fetches an expired hit', () => {
    expect(isFresh(row(true, TICKET_TTL_MS + 1_000), Date.now())).toBe(false);
  });

  it('keeps a miss cached far longer than a hit', () => {
    expect(isFresh(row(false, TICKET_TTL_MS + 1_000), Date.now())).toBe(true);
    expect(isFresh(row(false, TICKET_MISS_TTL_MS + 1_000), Date.now())).toBe(false);
  });
});

describe('toLookup', () => {
  const base = {
    prId: 'p',
    workspaceId: 'w',
    ticketKey: 'ENG-482',
    source: 'linear',
    fetchedAt: new Date('2026-08-29T10:00:00.000Z'),
  };

  it('maps a found row to an ok ticket', () => {
    const out = toLookup(
      {
        ...base,
        found: true,
        title: 'Add a retry budget',
        status: 'In Review',
        statusType: 'started',
        url: 'https://linear.app/acme/issue/ENG-482',
      } as PrTicketRow,
      { stale: false },
    );
    expect(out.state).toBe('ok');
    expect(out.ticket?.title).toBe('Add a retry budget');
    expect(out.ticket?.status).toBe('In Review');
    expect(out.ticket?.status_type).toBe('started');
    expect(out.ticket?.stale).toBe(false);
  });

  it('maps a negative row to not_found, keeping the key', () => {
    const out = toLookup(
      {
        ...base,
        found: false,
        title: null,
        status: null,
        statusType: null,
        url: null,
      } as PrTicketRow,
      { stale: false },
    );
    expect(out).toEqual({ state: 'not_found', key: 'ENG-482', ticket: null });
  });

  it('marks a cache-only answer stale', () => {
    const out = toLookup(
      {
        ...base,
        found: true,
        title: 'Add a retry budget',
        status: 'Done',
        statusType: 'completed',
        url: 'u',
      } as PrTicketRow,
      { stale: true },
    );
    expect(out.ticket?.stale).toBe(true);
  });
});

describe('clamping and status normalization', () => {
  it('caps a hostile title', () => {
    expect(clampTitle('x'.repeat(1_000))!.length).toBe(300);
  });

  it('maps an unknown state type instead of throwing', () => {
    expect(toStatusType('started')).toBe('started');
    expect(toStatusType('some_new_linear_type')).toBe('unknown');
    expect(toStatusType(null)).toBe('unknown');
  });
});
```

## `server/test/tickets.it.test.ts` *(new)*

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import type { SecretsProvider, TrackerIssue } from '@devdigest/shared';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import { MockIssueTracker } from '../src/adapters/mocks.js';
import * as t from '../src/db/schema.js';

/**
 * PR ticket context, end to end against a real Postgres.
 *
 * The load-bearing assertions are the ones a unit test cannot make:
 *   • a lookup is PERSISTED, and the second read does not touch the tracker
 *   • a miss is persisted too, so a false-positive branch key is asked ONCE
 *   • an unreachable tracker degrades to the cached row, flagged stale
 *   • an unconfigured tracker is a state, not a 500
 *
 * NOTE: every app here injects either `tickets` or a `secrets` stub. A
 * partially-injected container falls through to LocalSecretsProvider and can
 * make live, billed calls with a developer's real key — see server/INSIGHTS.md,
 * 2026-08-11.
 */

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const config = () => loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);

const ENG_482: TrackerIssue = {
  key: 'ENG-482',
  title: 'Add a retry budget to the webhook sender',
  status: 'In Review',
  statusType: 'started',
  url: 'https://linear.app/acme/issue/ENG-482',
};

/** A secrets backend with nothing in it — the "never configured" install. */
const emptySecrets: SecretsProvider = { get: async () => undefined };

let seq = 0;
async function setupPr(
  db: PgFixture['handle']['db'],
  workspaceId: string,
  branch: string,
) {
  const name = `tickets-api-${seq++}`;
  const [repo] = await db
    .insert(t.repos)
    .values({ workspaceId, owner: 'acme', name, fullName: `acme/${name}` })
    .returning();
  const [pr] = await db
    .insert(t.pullRequests)
    .values({
      workspaceId,
      repoId: repo!.id,
      number: 482,
      title: 'Add a retry budget',
      author: 'marisa.koch',
      branch,
      base: 'main',
      headSha: 'a1b2c3d4',
      status: 'needs_review',
    })
    .returning();
  return { repo: repo!, pr: pr! };
}

d('PR ticket context (Testcontainers pg)', () => {
  let pg: PgFixture;
  let workspaceId: string;

  beforeAll(async () => {
    pg = await startPg();
    await seed(pg.handle.db);
    const [ws] = await pg.handle.db.select().from(t.workspaces);
    workspaceId = ws!.id;
  });
  afterAll(async () => {
    await pg?.stop();
  });

  function appWith(tracker: MockIssueTracker) {
    return buildApp({
      config: config(),
      db: pg.handle.db,
      overrides: { secrets: emptySecrets, tickets: tracker },
    });
  }

  it('resolves the branch key and returns the issue title + status', async () => {
    const tracker = new MockIssueTracker({ issues: { 'ENG-482': ENG_482 } });
    const app = await appWith(tracker);
    const { pr } = await setupPr(pg.handle.db, workspaceId, 'feat/ENG-482-retry-budget');

    const res = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/ticket` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.state).toBe('ok');
    expect(body.key).toBe('ENG-482');
    expect(body.ticket.title).toBe(ENG_482.title);
    expect(body.ticket.status).toBe('In Review');
    expect(body.ticket.status_type).toBe('started');
    expect(body.ticket.stale).toBe(false);
    expect(tracker.calls).toEqual([{ team: 'ENG', number: 482, key: 'ENG-482' }]);

    // Persisted, not just returned.
    const [row] = await pg.handle.db
      .select()
      .from(t.prTickets)
      .where(eq(t.prTickets.prId, pr.id));
    expect(row!.ticketKey).toBe('ENG-482');
    expect(row!.found).toBe(true);
    expect(row!.title).toBe(ENG_482.title);

    await app.close();
  });

  it('serves the second read from cache and re-asks only on refresh', async () => {
    const tracker = new MockIssueTracker({ issues: { 'ENG-482': ENG_482 } });
    const app = await appWith(tracker);
    const { pr } = await setupPr(pg.handle.db, workspaceId, 'feat/ENG-482-retry-budget');

    await app.inject({ method: 'GET', url: `/pulls/${pr.id}/ticket` });
    await app.inject({ method: 'GET', url: `/pulls/${pr.id}/ticket` });
    expect(tracker.calls).toHaveLength(1);

    const res = await app.inject({ method: 'POST', url: `/pulls/${pr.id}/ticket/refresh` });
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe('ok');
    expect(tracker.calls).toHaveLength(2);

    await app.close();
  });

  it('never asks the tracker when the branch names no issue', async () => {
    const tracker = new MockIssueTracker({ issues: { 'ENG-482': ENG_482 } });
    const app = await appWith(tracker);
    const { pr } = await setupPr(pg.handle.db, workspaceId, 'chore/deps');

    const body = (await app.inject({ method: 'GET', url: `/pulls/${pr.id}/ticket` })).json();
    expect(body).toEqual({ state: 'no_reference', key: null, ticket: null });
    expect(tracker.calls).toHaveLength(0);

    await app.close();
  });

  it('caches a miss so a false-positive key is asked exactly once', async () => {
    const tracker = new MockIssueTracker({ issues: {} });
    const app = await appWith(tracker);
    const { pr } = await setupPr(pg.handle.db, workspaceId, 'chore/bump-node-20');

    const first = (await app.inject({ method: 'GET', url: `/pulls/${pr.id}/ticket` })).json();
    expect(first).toEqual({ state: 'not_found', key: 'NODE-20', ticket: null });

    const second = (await app.inject({ method: 'GET', url: `/pulls/${pr.id}/ticket` })).json();
    expect(second.state).toBe('not_found');
    expect(tracker.calls).toHaveLength(1);

    const [row] = await pg.handle.db
      .select()
      .from(t.prTickets)
      .where(eq(t.prTickets.prId, pr.id));
    expect(row!.found).toBe(false);

    await app.close();
  });

  it('falls back to the cached ticket, flagged stale, when the tracker is down', async () => {
    const { pr } = await setupPr(pg.handle.db, workspaceId, 'feat/ENG-482-retry-budget');

    const okApp = await appWith(new MockIssueTracker({ issues: { 'ENG-482': ENG_482 } }));
    await okApp.inject({ method: 'GET', url: `/pulls/${pr.id}/ticket` });
    await okApp.close();

    // Force a re-fetch against a tracker that now fails.
    const downApp = await appWith(new MockIssueTracker({ fail: true }));
    const body = (
      await downApp.inject({ method: 'POST', url: `/pulls/${pr.id}/ticket/refresh` })
    ).json();
    expect(body.state).toBe('ok');
    expect(body.ticket.title).toBe(ENG_482.title);
    expect(body.ticket.stale).toBe(true);
    await downApp.close();
  });

  it('reports unavailable — not 500 — when the tracker fails with nothing cached', async () => {
    const app = await appWith(new MockIssueTracker({ fail: true }));
    const { pr } = await setupPr(pg.handle.db, workspaceId, 'feat/ENG-999-new-thing');

    const res = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/ticket` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ state: 'unavailable', key: 'ENG-999', ticket: null });

    await app.close();
  });

  it('reports not_configured when no LINEAR_API_KEY is set', async () => {
    // No `tickets` override → container.tickets() resolves through the EMPTY
    // secrets stub and throws ConfigError, which the service turns into a state.
    const app = await buildApp({
      config: config(),
      db: pg.handle.db,
      overrides: { secrets: emptySecrets },
    });
    const { pr } = await setupPr(pg.handle.db, workspaceId, 'feat/ENG-482-retry-budget');

    const res = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/ticket` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ state: 'not_configured', key: 'ENG-482', ticket: null });

    await app.close();
  });

  it('404s a PR from another workspace', async () => {
    const app = await appWith(new MockIssueTracker());
    const [other] = await pg.handle.db
      .insert(t.workspaces)
      .values({ name: 'other-ws' })
      .returning();
    const { pr } = await setupPr(pg.handle.db, other!.id, 'feat/ENG-482-retry-budget');

    const res = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/ticket` });
    expect(res.statusCode).toBe(404);

    await app.close();
  });
});
```

---

## Verification

```bash
cd server
pnpm typecheck
pnpm exec vitest run --exclude '**/*.it.test.ts'   # unit lane (incl. tickets-helpers)
pnpm exec vitest run tickets.it.test               # needs Docker
pnpm db:generate                                    # produces 0017 + meta snapshot
pnpm db:migrate                                     # migrations are NOT applied on boot
```

## Follow-ups (deliberately not in this change)

- **Client.** Copy `contracts/tickets.ts` into `client/src/vendor/shared/`, add
  the barrel line, add `getPrTicket(prId)` to `src/lib/api.ts`, and render a
  `TicketCard` beside `IntentCard` under
  `client/src/app/repos/[repoId]/pulls/[number]/_components/`. The `state` field
  drives the four empty states; `status_type` drives the badge colour. Also
  resync `contracts/platform.ts` there to pick up the `linear` provider so the
  API-keys panel shows a Linear row.
- **Ticket in the review prompt.** If a later lesson wants the issue title in the
  reviewer prompt, the server resolves it via `TicketService` and passes it into
  `reviewer-core` as plain data — `reviewer-core` gets no tracker access.
- **Jira.** A second `IssueTrackerClient` implementation plus a per-workspace
  choice of tracker; the port, the module and `pr_tickets.source` already allow
  it without a schema change.
