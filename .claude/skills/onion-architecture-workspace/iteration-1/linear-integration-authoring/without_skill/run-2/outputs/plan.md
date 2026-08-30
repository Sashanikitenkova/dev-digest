# Linear ticket context on a pull request — server implementation plan

## Goal

When a PR's branch name references a Linear issue (`feat/ENG-482-retry-budget`,
`oli/eng-482-retry-budget`, `ENG-482`), the PR page shows that issue's **title**
and **current status**.

Scope: `server/` (`@devdigest/api`) only. The client is a consumer of one new
endpoint and is out of scope (see *Out of scope / follow-ups*).

---

## Design

### 1. Shape of the feature

One new read endpoint, mirroring the way `risks`, `blast`, `intent` and `brief`
already attach per-PR panels:

```
GET /pulls/:id/ticket            → PrTicket | null
GET /pulls/:id/ticket?refresh=true  → same, bypassing the TTL cache
```

`null` (200, not 404) is a first-class answer: "this branch does not reference a
Linear issue". The PR page renders no panel rather than an error. This follows
the intent module's precedent (`GET /pulls/:id/intent` returns `null` rather
than 404 so the UI can render an empty state).

The ticket is **not** folded into `PrDetail`. It is a separate endpoint for the
same reason `risks` is kept out of `blast`: the panels answer different
questions, are fed by a different external service, and must fail independently.
A Linear outage must not take `/pulls/:id` — the whole PR page — down with it.

### 2. Layering (routes → service → repository, port before adapter)

| Layer | File | Responsibility |
|---|---|---|
| Contract | `vendor/shared/contracts/platform.ts` | `PrTicket`, `TicketStatusType` wire DTOs |
| Port | `vendor/shared/adapters.ts` | `LinearClient`, `LinearIssue`, `LinearIssueRef` |
| Adapter | `adapters/linear/graphql.ts` | `LinearGraphQLClient` — the only file that knows Linear's GraphQL exists |
| Mock adapter | `adapters/mocks.ts` | `MockLinearClient` (no network, for tests) |
| Composition root | `platform/container.ts` | `container.linear()` — resolves `LINEAR_API_KEY` via `SecretsProvider`, cached, overridable |
| Route | `modules/tickets/routes.ts` | Zod params/querystring, workspace context, no logic |
| Service | `modules/tickets/service.ts` | cache/TTL/degradation policy |
| Repository | `modules/tickets/repository.ts` | the only code that touches `pr_tickets` |
| Pure helpers | `modules/tickets/helpers.ts` | branch → candidate identifiers, row → DTO |
| Schema | `db/schema/tickets.ts` + migration `0017` | `pr_tickets` |

No module reaches into another module's folder: `TicketsRepository` re-reads the
workspace-scoped PR row itself (the same house rule `RisksRepository` and
`IntentRepository` already state in their file headers).

### 3. Branch parsing — code proposes, Linear decides

Linear identifiers are `<TEAM-KEY>-<NUMBER>`. Linear's own "copy git branch
name" produces `<user>/<team>-<number>-<slug>`, all lowercase; hand-written
branches use `feat/ENG-482-...`. A regex alone cannot distinguish `ENG-482` from
`utf-8` or `sha-256`, so the split is deliberate:

* `parseTicketRefs()` (pure, unit-tested) extracts **candidates** — at most 3,
  last path segment first (that's where both conventions put the identifier),
  then the whole branch. Team key = `[A-Za-z][A-Za-z0-9]{1,4}` (Linear keys are
  1–5 chars; requiring ≥2 kills the `v2-1` class of false positive), number =
  1–7 digits not followed by another digit. Identifiers are normalised to
  uppercase and de-duplicated in order.
* **Linear adjudicates.** A candidate that isn't a real issue comes back `null`
  and is silently skipped. We never invent a ticket the tracker doesn't confirm
  — the same "model/heuristic proposes, code decides" discipline the conventions
  and intent modules use.

### 4. Caching and degradation (local-first)

`pr_tickets` is a one-row-per-PR cache, upserted on `pr_id` — structurally the
same as `pr_intent` / `pr_brief`.

Why cache at all, when `risks` deliberately doesn't? `risks` is a pure function
of rows we already own; a ticket is a network read against a rate-limited
third party. The pulls module's stated contract is *"Local-first: sync from
GitHub when a token is configured, but never fail the read"* — this endpoint
holds the same contract for Linear.

Resolution order in `TicketsService.getForPull`:

1. PR not in this workspace → `NotFoundError` (404). This is the only throw.
2. No candidate identifiers in the branch → `null`, **zero** Linear calls.
3. Cached row whose `identifier` is one of the current candidates and is younger
   than `TICKET_TTL_MS` (5 min) → serve it, `stale: false`. `?refresh=true`
   skips this step.
4. Otherwise call Linear, first candidate that resolves wins → upsert → serve
   fresh.
5. No `LINEAR_API_KEY`, or the call fails → log at `warn`, serve the cached row
   with `stale: true`; if there is none, `null`.

A cached row for a *different* identifier is never a fallback. If the branch is
renamed `ENG-482` → `ENG-501` and Linear is unreachable, the answer is `null`,
not the previous ticket — serving a stale row for a ticket the branch no longer
names would be actively wrong.

**Accepted tradeoff:** there is no negative cache. A branch like
`fix/utf-8-encoding` produces one candidate and therefore one Linear lookup per
page view. Linear's personal-key budget is ~1500 req/h and the route carries its
own `rateLimit: { max: 60, timeWindow: '1 minute' }`, so this is bounded. Adding
a `resolved` sentinel column to model "we looked and there is nothing" was
rejected as more schema than the problem is worth.

### 5. Secrets & configuration

`LINEAR_API_KEY` resolves through `SecretsProvider` (`~/.devdigest/secrets.json`,
`process.env` fallback) — never `AppConfig`/`.env`, per the server convention.
So that the key is settable from the studio rather than only by hand-editing the
secrets file, `linear` is added to `ConnTestProvider`, `SecretsStatus` and
`SECRET_KEY_BY_PROVIDER`, with a `viewer { name }` branch in
`POST /settings/test-connection` (the exact shape of the existing `github` →
`currentLogin()` branch). That is why the port carries `viewer()` as well as
`getIssue()`.

### 6. Resilience

The adapter wraps every request in `withRetry(withTimeout(...))`, as
`OctokitGitHubClient` does. Failures are thrown as `LinearApiError` carrying a
`status` field, which is exactly what `platform/resilience.ts`'s
`defaultIsRetryable` reads — so 429/5xx retry with backoff and 4xx does not.
GraphQL errors arrive with HTTP 200 and a populated `errors` array; those are
raised with `status: 400` so they fail fast instead of retrying three times.

### 7. Risks noted from `server/INSIGHTS.md`

* *"`now()` in `db/schema/_shared.ts` is a `created_at` factory"* — `fetchedAt`
  is spelled out inline, not built with `now()`.
* *"`.default([])` on a shared Zod contract field is a BREAKING change"* —
  `PrTicket` is a new schema; the only additions to existing contracts are
  `ConnTestProvider` (enum widening, safe) and `SecretsStatus.linear`, whose sole
  producer is the settings route that derives it from `SECRET_KEY_BY_PROVIDER`.
* *"Grep `test/` too before calling a shared-contract field safe to add"* —
  `SecretsStatus` and `ConnTestProvider` appear in no test fixture
  (`test/contracts.test.ts` does not parse them).
* *"An integration test that injects only SOME providers silently hits the real
  network"* — `tickets.it.test.ts` injects `linear`, `github`, `git` and
  `embedder`; the ticket path resolves no LLM provider at all.
* *"`drizzle-kit generate` blocks on an interactive prompt"* — migration 0017 is
  a pure addition (one new table), so `pnpm db:generate` will not prompt.

### 8. Verification

```
cd server
pnpm typecheck
pnpm exec vitest run --exclude '**/*.it.test.ts'   # incl. tickets-helpers.test.ts
pnpm db:generate                                    # regenerates 0017 + meta snapshot
pnpm db:migrate                                     # migrations are NOT applied on boot
pnpm exec vitest run tickets                        # needs Docker
```

### Out of scope / follow-ups

* **Client.** `client/src/vendor/shared/contracts/platform.ts` and
  `client/src/lib/types.ts` need the same `PrTicket` addition, plus a
  `useTicket(prId)` hook and a panel on the PR page; `SettingsApiKeys` needs a
  Linear row. The vendored copies are hand-synced (no workspace linking), so the
  server copy diverging is expected until that lands.
* Resolving tickets from the PR **title/body** as well as the branch —
  `parseTicketRefs` already takes a plain string, so it is a one-line extension.
* A per-workspace team-key allowlist to suppress `utf-8`-style candidates before
  they cost a round trip.
* Feeding the ticket into the review prompt (`brief`/`intent` source ledger) as a
  `linear_ticket` source.

---

## Files

> Convention used below: **new files are given in full**; **existing files are
> given as an exact, anchored diff** of the lines that change, since reproducing
> ~400 lines of `platform.ts` or `container.ts` verbatim adds transcription risk
> without adding information.

---

### `server/src/vendor/shared/contracts/platform.ts` *(modified — append after the `PrCommentInput` block, before `// ---- Project Context (SPEC-01) ----`)*

```ts
// ---- Issue-tracker ticket (Linear) ----

/**
 * Normalised workflow-state category. Mirrors Linear's `WorkflowState.type`
 * plus an explicit `unknown` — a state category the API adds later is reported
 * as unknown rather than silently coerced into a neighbouring bucket, so the UI
 * can render a neutral chip instead of a wrong one.
 */
export const TicketStatusType = z.enum([
  'triage',
  'backlog',
  'unstarted',
  'started',
  'completed',
  'canceled',
  'unknown',
]);
export type TicketStatusType = z.infer<typeof TicketStatusType>;

/**
 * The issue-tracker ticket a PR's BRANCH points at (GET /pulls/:id/ticket).
 *
 * `status` is the workspace's own display name for the state ("In Review"),
 * which is what a reviewer recognises; `status_type` is the normalised category
 * a chip colour can key off. Both are kept — the display name is not derivable
 * from the category, and the category is not derivable from a custom name.
 *
 * `stale: true` means the row was served from the local cache because Linear
 * could not be reached. It is deliberately part of the contract rather than a
 * header: "In Review, as of 40 minutes ago" and "In Review" are different
 * claims and the UI has to be able to say which one it is showing.
 */
export const PrTicket = z.object({
  provider: z.literal('linear'),
  /** e.g. `ENG-482`, always upper-cased. */
  identifier: z.string(),
  title: z.string(),
  /** Workflow-state display name, e.g. `In Review`. */
  status: z.string(),
  status_type: TicketStatusType,
  url: z.string(),
  assignee: z.string().nullish(),
  /** When the ISSUE last changed in Linear (not when we read it). */
  updated_at: z.string().nullish(),
  /** When DevDigest last successfully read it. */
  fetched_at: z.string(),
  stale: z.boolean(),
});
export type PrTicket = z.infer<typeof PrTicket>;
```

Two existing schemas in the same file gain a `linear` member:

```diff
 // ---- Connection test ----
-export const ConnTestProvider = z.enum(['openai', 'anthropic', 'openrouter', 'github']);
+export const ConnTestProvider = z.enum(['openai', 'anthropic', 'openrouter', 'github', 'linear']);
 export type ConnTestProvider = z.infer<typeof ConnTestProvider>;
```

```diff
 export const SecretsStatus = z.object({
   openai: z.boolean(),
   anthropic: z.boolean(),
   openrouter: z.boolean(),
   github: z.boolean(),
+  linear: z.boolean(),
 });
 export type SecretsStatus = z.infer<typeof SecretsStatus>;
```

---

### `server/src/vendor/shared/adapters.ts` *(modified)*

Import the new status type alongside the existing platform imports:

```diff
 import type {
   PrMeta,
   PrDetail,
   IssueMeta,
   PrReviewComment,
+  TicketStatusType,
 } from './contracts/platform.js';
```

Add the port between the `GitHubClient` block and `// ---------- Git (simple-git, heavy) ----------`:

```ts
// ---------- Linear (issue tracker, GraphQL) ----------

/** A parsed `TEAM-NUMBER` reference, already split for the API's filter args. */
export interface LinearIssueRef {
  /** Upper-cased team key, e.g. `ENG`. */
  team: string;
  /** Issue number within the team, e.g. `482`. */
  number: number;
  /** `${team}-${number}`, e.g. `ENG-482`. The stable public identity. */
  identifier: string;
}

/** One Linear issue, reduced to what a PR panel needs. */
export interface LinearIssue {
  identifier: string;
  title: string;
  /** Workflow-state display name as configured in the workspace ("In Review"). */
  stateName: string;
  /** Normalised state category; `unknown` for a category we don't model. */
  stateType: TicketStatusType;
  url: string;
  assignee: string | null;
  /** ISO-8601 timestamp of the issue's last change, when the API reports one. */
  updatedAt: string | null;
}

export interface LinearClient {
  /**
   * The issue for a `TEAM-NUMBER` reference, or `null` when the workspace has
   * no such issue. `null` is NOT an error: branch-name parsing is heuristic, so
   * a candidate that doesn't resolve is simply a false positive to skip.
   * Throws only for transport/auth failures.
   */
  getIssue(ref: LinearIssueRef): Promise<LinearIssue | null>;
  /** Display name of the authenticated user — the cheap connection test. */
  viewer(): Promise<string>;
}
```

And name the new secret key in the union (documentation only — the union is open):

```diff
 export type SecretKey =
   | 'OPENAI_API_KEY'
   | 'ANTHROPIC_API_KEY'
   | 'GITHUB_TOKEN'
+  | 'LINEAR_API_KEY'
   | 'DATABASE_URL'
   | (string & {});
```

---

### `server/src/adapters/linear/graphql.ts` *(new)*

```ts
import type {
  LinearClient,
  LinearIssue,
  LinearIssueRef,
  TicketStatusType,
} from '@devdigest/shared';
import { withRetry, withTimeout } from '../../platform/resilience.js';

/**
 * LinearClient over Linear's GraphQL API — thin, and the ONLY file in the
 * server that knows Linear speaks GraphQL.
 *
 * Auth: a personal API key is sent RAW in `Authorization` (Linear's documented
 * scheme); an OAuth access token uses the `Bearer` prefix. We detect the OAuth
 * shape by prefix rather than asking the user which kind of credential they
 * pasted.
 *
 * Lookup is by `(team key, issue number)` through the `issues` filter rather
 * than `issue(id:)`, because the filter is unambiguous about what an identifier
 * like `ENG-482` means and returns an empty node list — not an error — for a
 * reference that does not exist. That distinction is load-bearing: the caller
 * treats "no such issue" as a false-positive branch match and moves on, but
 * treats a thrown error as an outage and falls back to its cache.
 */

const LINEAR_API_URL = 'https://api.linear.app/graphql';
const TIMEOUT = 10_000;

const ISSUE_QUERY = `
  query DevDigestIssueByIdentifier($team: String!, $number: Float!) {
    issues(filter: { team: { key: { eq: $team } }, number: { eq: $number } }, first: 1) {
      nodes {
        identifier
        title
        url
        updatedAt
        state { name type }
        assignee { displayName }
      }
    }
  }
`;

const VIEWER_QUERY = `query DevDigestViewer { viewer { name } }`;

/** Linear's own `WorkflowState.type` values. Anything else → `unknown`. */
const KNOWN_STATE_TYPES: readonly string[] = [
  'triage',
  'backlog',
  'unstarted',
  'started',
  'completed',
  'canceled',
];

function normalizeStateType(raw: unknown): TicketStatusType {
  return KNOWN_STATE_TYPES.includes(String(raw)) ? (raw as TicketStatusType) : 'unknown';
}

/**
 * Carries `status` so `platform/resilience.ts`'s `defaultIsRetryable` can read
 * it: 429/5xx back off and retry, 4xx fails immediately.
 */
export class LinearApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'LinearApiError';
  }
}

interface RawIssueNode {
  identifier?: string;
  title?: string;
  url?: string;
  updatedAt?: string | null;
  state?: { name?: string; type?: string } | null;
  assignee?: { displayName?: string } | null;
}

export class LinearGraphQLClient implements LinearClient {
  constructor(
    private readonly apiKey: string,
    /** Injectable for unit tests; defaults to Node 22's global fetch. */
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private authorization(): string {
    return this.apiKey.startsWith('lin_oauth_') ? `Bearer ${this.apiKey}` : this.apiKey;
  }

  private async request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    return withRetry(() =>
      withTimeout(
        (async () => {
          const res = await this.fetchImpl(LINEAR_API_URL, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: this.authorization(),
            },
            body: JSON.stringify({ query, variables }),
          });
          if (!res.ok) {
            throw new LinearApiError(`Linear API returned HTTP ${res.status}`, res.status);
          }
          const body = (await res.json()) as {
            data?: T;
            errors?: { message?: string }[];
          };
          // GraphQL errors arrive with HTTP 200. Raise them as 400 so the retry
          // policy fails fast rather than replaying a malformed query 3 times.
          if (body.errors?.length) {
            const detail = body.errors.map((e) => e.message ?? 'unknown error').join('; ');
            throw new LinearApiError(`Linear API error: ${detail}`, 400);
          }
          if (!body.data) throw new LinearApiError('Linear API returned no data', 400);
          return body.data;
        })(),
        TIMEOUT,
      ),
    );
  }

  async getIssue(ref: LinearIssueRef): Promise<LinearIssue | null> {
    const data = await this.request<{ issues?: { nodes?: RawIssueNode[] } }>(ISSUE_QUERY, {
      team: ref.team,
      number: ref.number,
    });
    const node = data.issues?.nodes?.[0];
    if (!node) return null;
    return {
      identifier: node.identifier ?? ref.identifier,
      title: node.title ?? ref.identifier,
      stateName: node.state?.name ?? 'Unknown',
      stateType: normalizeStateType(node.state?.type),
      url: node.url ?? `https://linear.app/issue/${ref.identifier}`,
      assignee: node.assignee?.displayName ?? null,
      updatedAt: node.updatedAt ?? null,
    };
  }

  async viewer(): Promise<string> {
    const data = await this.request<{ viewer?: { name?: string } }>(VIEWER_QUERY, {});
    return data.viewer?.name ?? 'unknown';
  }
}
```

---

### `server/src/adapters/mocks.ts` *(modified)*

Extend the type import block:

```diff
   SecretsProvider,
   SecretKey,
+  LinearClient,
+  LinearIssue,
+  LinearIssueRef,
 } from '@devdigest/shared';
```

Append the mock (after `MockGitHubClient`, before the Git mock):

```ts
// ---------- Mock Linear ----------
export interface MockLinearOptions {
  /** Issues keyed by identifier (`ENG-482`). Anything not listed resolves null. */
  issues?: Record<string, LinearIssue>;
  viewerName?: string;
  /** When set, every call rejects with it — simulates a Linear outage. */
  fail?: Error;
}

/** Default fixture: the ticket the deterministic e2e/branch fixtures reference. */
const DEFAULT_LINEAR_ISSUE: LinearIssue = {
  identifier: 'ENG-482',
  title: 'Add a retry budget to the webhook dispatcher',
  stateName: 'In Review',
  stateType: 'started',
  url: 'https://linear.app/acme/issue/ENG-482',
  assignee: 'marisa.koch',
  updatedAt: '2026-06-01T03:00:00Z',
};

export class MockLinearClient implements LinearClient {
  /** Every lookup, in order — lets a test assert the TTL cache prevented a call. */
  public lookups: LinearIssueRef[] = [];

  constructor(private opts: MockLinearOptions = {}) {}

  async getIssue(ref: LinearIssueRef): Promise<LinearIssue | null> {
    this.lookups.push(ref);
    if (this.opts.fail) throw this.opts.fail;
    const table = this.opts.issues ?? { [DEFAULT_LINEAR_ISSUE.identifier]: DEFAULT_LINEAR_ISSUE };
    return table[ref.identifier] ?? null;
  }

  async viewer(): Promise<string> {
    if (this.opts.fail) throw this.opts.fail;
    return this.opts.viewerName ?? 'mock-linear-user';
  }
}
```

---

### `server/src/adapters/index.ts` *(modified)*

```diff
 export { OctokitGitHubClient } from './github/octokit.js';
+export { LinearGraphQLClient, LinearApiError } from './linear/graphql.js';
 export { SimpleGitClient } from './git/simple-git.js';
```

---

### `server/src/db/schema/tickets.ts` *(new)*

```ts
import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';
import { pullRequests } from './pulls';

/**
 * `pr_tickets` — the last issue-tracker ticket successfully resolved for a PR.
 *
 * ONE row per PR (pr_id is the PK), upserted on every successful read: the same
 * shape as `pr_intent` / `pr_brief`, and for the same reason — this is a cache
 * of a derived fact, not a history.
 *
 * It exists so the panel survives a Linear outage or a missing API key, in line
 * with the pulls module's local-first contract ("never fail the read"). The row
 * is only ever served for the identifier the CURRENT branch still names; see
 * `TicketsService.getForPull`.
 *
 * `provider` is `'linear'` today and carries no other value; it is a column
 * rather than an assumption so a second tracker does not need a migration to
 * tell the two apart.
 *
 * NOTE: `fetched_at` is spelled out inline rather than built with the `now()`
 * helper in `_shared.ts` — that helper hard-codes the column NAME `created_at`.
 */
export const prTickets = pgTable('pr_tickets', {
  prId: uuid('pr_id')
    .primaryKey()
    .references(() => pullRequests.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull().default('linear'),
  /** `ENG-482`, upper-cased. */
  identifier: text('identifier').notNull(),
  title: text('title').notNull(),
  /** Workflow-state display name as configured in the Linear workspace. */
  statusName: text('status_name').notNull(),
  /** Normalised state category; `unknown` when Linear reports one we don't model. */
  statusType: text('status_type').notNull().default('unknown'),
  url: text('url').notNull(),
  assignee: text('assignee'),
  /** When the ISSUE last changed in Linear (not when we read it). */
  issueUpdatedAt: timestamp('issue_updated_at', { withTimezone: true }),
  /** When DevDigest last read it successfully — the TTL is measured from here. */
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).defaultNow().notNull(),
});
```

---

### `server/src/db/schema.ts` *(modified)*

```diff
 export * from './schema/pulls';
+export * from './schema/tickets';
 export * from './schema/reviews';
```

```diff
 import { pullRequests, prFiles, prCommits } from './schema/pulls';
+import { prTickets } from './schema/tickets';
 import { reviews, findings, prIntent, prBrief } from './schema/reviews';
```

```diff
   pullRequests,
   prFiles,
   prCommits,
+  prTickets,
   reviews,
```

---

### `server/src/db/migrations/0017_curious_black_widow.sql` *(new)*

> Generate with `pnpm db:generate` — it also writes `meta/0017_snapshot.json`
> and the `_journal.json` entry below. This is a pure addition (one new table),
> so drizzle-kit will not hit the interactive "created or renamed?" prompt.
> The SQL it produces is:

```sql
CREATE TABLE "pr_tickets" (
	"pr_id" uuid PRIMARY KEY NOT NULL,
	"provider" text DEFAULT 'linear' NOT NULL,
	"identifier" text NOT NULL,
	"title" text NOT NULL,
	"status_name" text NOT NULL,
	"status_type" text DEFAULT 'unknown' NOT NULL,
	"url" text NOT NULL,
	"assignee" text,
	"issue_updated_at" timestamp with time zone,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pr_tickets" ADD CONSTRAINT "pr_tickets_pr_id_pull_requests_id_fk" FOREIGN KEY ("pr_id") REFERENCES "public"."pull_requests"("id") ON DELETE cascade ON UPDATE no action;
```

### `server/src/db/migrations/meta/_journal.json` *(modified)*

```diff
     {
       "idx": 16,
       "version": "7",
       "when": 1787979995438,
       "tag": "0016_glamorous_revanche",
       "breakpoints": true
-    }
+    },
+    {
+      "idx": 17,
+      "version": "7",
+      "when": 1788400000000,
+      "tag": "0017_curious_black_widow",
+      "breakpoints": true
+    }
   ]
 }
```

---

### `server/src/platform/container.ts` *(modified)*

```diff
 import type {
   AuthProvider,
   SecretsProvider,
   GitHubClient,
+  LinearClient,
   GitClient,
   CodeIndex,
   Embedder,
   LLMProvider,
 } from '@devdigest/shared';
```

```diff
 import { OctokitGitHubClient } from '../adapters/github/octokit.js';
+import { LinearGraphQLClient } from '../adapters/linear/graphql.js';
 import { SimpleGitClient } from '../adapters/git/simple-git.js';
```

```diff
 export interface ContainerOverrides {
   secrets?: SecretsProvider;
   auth?: AuthProvider;
   github?: GitHubClient;
+  /** Issue tracker (Linear). Tests inject MockLinearClient — no network. */
+  linear?: LinearClient;
   git?: GitClient;
```

```diff
   private _git?: GitClient;
   private _github?: GitHubClient;
+  private _linear?: LinearClient;
   private _codeIndex?: CodeIndex;
```

Add the resolver next to `github()`:

```ts
  /**
   * Issue-tracker client. Constructed from `LINEAR_API_KEY` (SecretsProvider,
   * never AppConfig) and cached. Throws `ConfigError` when unset — the tickets
   * service catches that and degrades to its cache, so an install with no
   * Linear key behaves exactly as it did before this feature existed.
   */
  async linear(): Promise<LinearClient> {
    if (this.overrides.linear) return this.overrides.linear;
    if (this._linear) return this._linear;
    const key = await this.secrets.get('LINEAR_API_KEY');
    if (!key) throw new ConfigError('LINEAR_API_KEY is not configured');
    this._linear = new LinearGraphQLClient(key);
    return this._linear;
  }
```

```diff
   invalidateSecretCaches(): void {
     this.llmCache.clear();
     this._github = undefined;
+    this._linear = undefined;
     this._embedder = undefined;
   }
```

---

### `server/src/modules/tickets/constants.ts` *(new)*

```ts
/** Constants for the tickets module. */

/**
 * How long a cached ticket is served without re-reading Linear.
 *
 * A ticket's STATUS is the volatile half of what the panel shows, and it moves
 * on human timescales (a reviewer flips it to "Done" and then looks at the PR),
 * so this is short. `?refresh=true` exists for the impatient case.
 */
export const TICKET_TTL_MS = 5 * 60_000;

/**
 * Most candidate identifiers we will ask Linear about for one branch.
 *
 * Branch-name parsing is heuristic, so each candidate is a potential wasted
 * round trip; three covers "the identifier is in the last segment" plus a
 * couple of oddities and bounds the cost of a pathological branch name.
 */
export const MAX_TICKET_CANDIDATES = 3;

/**
 * Team key + issue number, anchored on a non-alphanumeric boundary (or start).
 *
 * The key is 2–5 characters starting with a letter: Linear allows 1–5, but
 * permitting one character makes `release/v2-1` and `chore/x-1` look like
 * tickets, and a one-character team key is rare enough not to be worth that.
 * The number is 1–7 digits NOT followed by another digit, so a version string
 * like `lib-1234567890` does not match.
 *
 * False positives (`utf-8`, `sha-256`) survive this regex on purpose — Linear
 * is the adjudicator; see `TicketsService.getForPull`.
 */
export const TICKET_REF_RE = /(?:^|[^A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,4})-(\d{1,7})(?![0-9])/g;
```

---

### `server/src/modules/tickets/helpers.ts` *(new)*

```ts
import type { LinearIssueRef, PrTicket, TicketStatusType } from '@devdigest/shared';
import { TicketStatusType as TicketStatusTypeSchema } from '@devdigest/shared';
import type { PrTicketRow } from './repository.js';
import { MAX_TICKET_CANDIDATES, TICKET_REF_RE } from './constants.js';

/**
 * Pure helpers for the tickets module. Everything here is a total function of
 * its arguments — no db, no network — which is what makes the branch-parsing
 * rules cheap to pin down in `test/tickets-helpers.test.ts`.
 */

/**
 * Candidate Linear identifiers referenced by a branch name, best guess first.
 *
 * Both conventions in the wild put the identifier at the START of the LAST path
 * segment — Linear's own "copy git branch name" gives `oli/eng-482-retry-budget`,
 * and hand-written branches give `feat/ENG-482-retry-budget` — so the last
 * segment is scanned first and the whole branch second. Results are upper-cased
 * (`eng-482` and `ENG-482` are the same ticket), de-duplicated in order, and
 * capped at `MAX_TICKET_CANDIDATES`.
 *
 * This returns CANDIDATES, not tickets. `fix/utf-8-encoding` yields `UTF-8`,
 * and that is fine: the caller asks Linear, which answers `null`, and nothing is
 * shown. Guessing less aggressively here would mean missing real tickets;
 * guessing more aggressively costs at most one bounded API call.
 */
export function parseTicketRefs(branch: string): LinearIssueRef[] {
  const segments = branch.split('/');
  const lastSegment = segments[segments.length - 1] ?? '';
  // Last segment first, then the whole branch (which re-finds the same matches
  // plus any that live in an earlier segment). De-duplication keeps the order.
  const sources = lastSegment === branch ? [branch] : [lastSegment, branch];

  const seen = new Set<string>();
  const refs: LinearIssueRef[] = [];

  for (const source of sources) {
    for (const match of source.matchAll(TICKET_REF_RE)) {
      const team = (match[1] ?? '').toUpperCase();
      // Number() strips leading zeros, so `eng-0482` and `ENG-482` converge on
      // one identifier — Linear issue numbers never carry them.
      const number = Number(match[2]);
      if (!team || !Number.isSafeInteger(number) || number <= 0) continue;
      const identifier = `${team}-${number}`;
      if (seen.has(identifier)) continue;
      seen.add(identifier);
      refs.push({ team, number, identifier });
      if (refs.length >= MAX_TICKET_CANDIDATES) return refs;
    }
  }
  return refs;
}

/** A persisted status category, or `unknown` for a value written by an older build. */
export function toStatusType(raw: string): TicketStatusType {
  const parsed = TicketStatusTypeSchema.safeParse(raw);
  return parsed.success ? parsed.data : 'unknown';
}

/**
 * Row → wire DTO. `stale` is supplied by the caller rather than derived from
 * `fetchedAt`, because it means "Linear could not be reached just now", not
 * "this row is older than the TTL" — a row can be past its TTL and still be
 * refreshed successfully on the very next call.
 */
export function toTicketDto(row: PrTicketRow, stale: boolean): PrTicket {
  return {
    provider: 'linear',
    identifier: row.identifier,
    title: row.title,
    status: row.statusName,
    status_type: toStatusType(row.statusType),
    url: row.url,
    assignee: row.assignee,
    updated_at: row.issueUpdatedAt?.toISOString() ?? null,
    fetched_at: row.fetchedAt.toISOString(),
    stale,
  };
}
```

---

### `server/src/modules/tickets/repository.ts` *(new)*

```ts
import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';
import type { PullRow } from '../../db/rows.js';

/**
 * Tickets data-access — the ONLY layer touching `pr_tickets`.
 *
 * It also reads the PR row directly, per the house rule the risks and intent
 * repositories both state: a module never reaches into another module's folder,
 * and a plain workspace-scoped row read is not another module's business logic.
 */

export type PrTicketRow = typeof t.prTickets.$inferSelect;

/** Everything one successful Linear read writes. `prId` is the conflict target. */
export interface UpsertTicket {
  prId: string;
  identifier: string;
  title: string;
  statusName: string;
  statusType: string;
  url: string;
  assignee: string | null;
  issueUpdatedAt: Date | null;
}

export class TicketsRepository {
  constructor(private db: Db) {}

  /**
   * Workspace-scoped PR guard. `undefined` when the PR does not exist IN THIS
   * WORKSPACE — the service turns that into a 404, never a cross-tenant read.
   * The branch name is the input the whole feature is derived from, so the full
   * row is returned rather than a boolean.
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
   * One row per PR: a refresh (or a branch that now names a different ticket)
   * overwrites in place, so `pr_tickets` never accumulates history. `fetchedAt`
   * is bumped explicitly because the column default only applies on insert.
   */
  async upsert(values: UpsertTicket): Promise<PrTicketRow> {
    const set = {
      provider: 'linear',
      identifier: values.identifier,
      title: values.title,
      statusName: values.statusName,
      statusType: values.statusType,
      url: values.url,
      assignee: values.assignee,
      issueUpdatedAt: values.issueUpdatedAt,
      fetchedAt: new Date(),
    };
    const [row] = await this.db
      .insert(t.prTickets)
      .values({ prId: values.prId, ...set })
      .onConflictDoUpdate({ target: t.prTickets.prId, set })
      .returning();
    return row!;
  }
}
```

---

### `server/src/modules/tickets/service.ts` *(new)*

```ts
import type { LinearClient, PrTicket } from '@devdigest/shared';
import type { Container } from '../../platform/container.js';
import { NotFoundError } from '../../platform/errors.js';
import { TicketsRepository, type PrTicketRow } from './repository.js';
import { parseTicketRefs, toTicketDto } from './helpers.js';
import { TICKET_TTL_MS } from './constants.js';

/**
 * Linear ticket context for a PR, derived from its BRANCH NAME.
 *
 * Three rules shape everything below.
 *
 *  1. LINEAR ADJUDICATES. `parseTicketRefs` proposes candidates; only an issue
 *     the API actually returns is shown. A branch like `fix/utf-8-encoding`
 *     produces the candidate `UTF-8`, Linear returns null, and the panel stays
 *     empty. We never render a ticket the tracker did not confirm.
 *
 *  2. THE READ NEVER FAILS. Missing key, outage, rate limit — all degrade to the
 *     cached row (flagged `stale`) or to `null`. Only an unknown PR throws. This
 *     is the pulls module's local-first contract applied to a second upstream:
 *     a PR page must not go down because an issue tracker did.
 *
 *  3. A CACHED ROW BELONGS TO AN IDENTIFIER, NOT TO A PR. If the branch is
 *     renamed to name a different ticket, the previous row is not a fallback for
 *     it. Serving `ENG-482` for a branch that now says `ENG-501` would be a
 *     confident wrong answer, which is worse than no answer.
 */

/** Minimal structured-log sink, satisfied by Fastify's `req.log.warn`. */
export type TicketLogger = (obj: Record<string, unknown>, msg: string) => void;

export interface GetTicketOptions {
  /** Bypass the TTL and re-read Linear (the panel's "Refresh" button). */
  refresh?: boolean;
  log?: TicketLogger;
  /** Injectable clock for tests. */
  now?: number;
}

export class TicketsService {
  private repo: TicketsRepository;

  constructor(private container: Container) {
    this.repo = new TicketsRepository(container.db);
  }

  async getForPull(
    workspaceId: string,
    prId: string,
    opts: GetTicketOptions = {},
  ): Promise<PrTicket | null> {
    const pull = await this.repo.getPull(workspaceId, prId);
    if (!pull) throw new NotFoundError('Pull request not found');

    const refs = parseTicketRefs(pull.branch);
    // The common case for a repo that does not use Linear: zero API calls, zero
    // db writes, and no way for this feature to cost anything.
    if (refs.length === 0) return null;

    const candidates = new Set(refs.map((r) => r.identifier));
    const cached = await this.repo.getByPr(prId);
    const usable: PrTicketRow | undefined =
      cached && candidates.has(cached.identifier) ? cached : undefined;

    const now = opts.now ?? Date.now();
    if (!opts.refresh && usable && now - usable.fetchedAt.getTime() < TICKET_TTL_MS) {
      return toTicketDto(usable, false);
    }

    let linear: LinearClient;
    try {
      linear = await this.container.linear();
    } catch (err) {
      // No LINEAR_API_KEY configured. Not an error the user needs shouted at
      // them on every PR page — the panel simply shows what we already have.
      opts.log?.(
        { err: (err as Error).message, prId },
        'Linear client unavailable; serving persisted ticket',
      );
      return usable ? toTicketDto(usable, true) : null;
    }

    try {
      for (const ref of refs) {
        const issue = await linear.getIssue(ref);
        if (!issue) continue; // false-positive candidate — try the next one
        const row = await this.repo.upsert({
          prId,
          identifier: issue.identifier,
          title: issue.title,
          statusName: issue.stateName,
          statusType: issue.stateType,
          url: issue.url,
          assignee: issue.assignee,
          issueUpdatedAt: issue.updatedAt ? new Date(issue.updatedAt) : null,
        });
        return toTicketDto(row, false);
      }
      // Every candidate resolved to nothing. That is an answer, not a failure:
      // report it even if a stale row exists, because the ticket the branch
      // names does not (any longer) exist.
      return null;
    } catch (err) {
      opts.log?.(
        { err: (err as Error).message, prId, branch: pull.branch },
        'Linear lookup failed; serving persisted ticket',
      );
      return usable ? toTicketDto(usable, true) : null;
    }
  }
}
```

---

### `server/src/modules/tickets/routes.ts` *(new)*

```ts
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { PrTicket } from '@devdigest/shared';
import { getContext } from '../_shared/context.js';
import { IdParams } from '../_shared/schemas.js';
import { TicketsService } from './service.js';

/**
 * Tickets module.
 *   GET /pulls/:id/ticket → the Linear issue this PR's BRANCH names, or null
 *
 * `null` rather than 404 for "this branch names no ticket", so the PR page
 * renders no panel instead of an error — the same convention
 * `GET /pulls/:id/intent` uses for a PR that has never been classified.
 *
 * Kept out of `GET /pulls/:id` deliberately: that endpoint must not acquire a
 * dependency on a second external service. A Linear outage degrades this panel
 * and nothing else.
 */

const TicketQuery = z.object({
  /**
   * `?refresh=true` bypasses the TTL cache and re-reads Linear. Declared as a
   * two-value enum rather than `z.coerce.boolean()`, which parses the STRING
   * "false" as `true` and would make the off switch mean on.
   */
  refresh: z.enum(['true', 'false']).optional(),
});

export default async function ticketsRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const service = new TicketsService(app.container);

  app.get(
    '/pulls/:id/ticket',
    {
      schema: { params: IdParams, querystring: TicketQuery },
      // At most one third-party call per hit, against a rate-limited API —
      // a tighter budget than the global one the pollers are sized for.
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (req): Promise<PrTicket | null> => {
      const { workspaceId } = await getContext(app.container, req);
      return service.getForPull(workspaceId, req.params.id, {
        refresh: req.query.refresh === 'true',
        log: (obj, msg) => req.log.warn(obj, msg),
      });
    },
  );
}
```

---

### `server/src/modules/index.ts` *(modified)*

```diff
 import pulls from './pulls/routes.js';
+import tickets from './tickets/routes.js';
 import polling from './polling/routes.js';
```

```diff
   settings,
   repos,
   pulls,
+  tickets,
   polling,
```

---

### `server/src/modules/settings/constants.ts` *(modified)*

```diff
 /** Provider id used by the GitHub connection test branch. */
 export const GITHUB_PROVIDER = 'github';

+/** Provider id used by the Linear connection test branch. */
+export const LINEAR_PROVIDER = 'linear';
+
 /** Maps a connection-test provider to the SecretsProvider key it persists to. */
 export const SECRET_KEY_BY_PROVIDER: Record<ConnTestProvider, SecretKey> = {
   openai: 'OPENAI_API_KEY',
   anthropic: 'ANTHROPIC_API_KEY',
   openrouter: 'OPENROUTER_API_KEY',
   github: 'GITHUB_TOKEN',
+  linear: 'LINEAR_API_KEY',
 };
```

---

### `server/src/modules/settings/routes.ts` *(modified)*

```diff
-import { GITHUB_PROVIDER, SECRET_KEY_BY_PROVIDER } from './constants.js';
+import { GITHUB_PROVIDER, LINEAR_PROVIDER, SECRET_KEY_BY_PROVIDER } from './constants.js';
```

```diff
       if (provider === GITHUB_PROVIDER) {
         const gh = await container.github();
         const login = await gh.currentLogin();
         return { provider, ok: true, message: `Connected as @${login}` };
       }
+      // Linear is not an LLM provider, so it cannot fall through to the
+      // `listModels()` branch below — it gets the same shape as GitHub: one
+      // cheap authenticated read (`viewer { name }`).
+      if (provider === LINEAR_PROVIDER) {
+        const linear = await container.linear();
+        const name = await linear.viewer();
+        return { provider, ok: true, message: `Connected as ${name}` };
+      }
       const llm = await container.llm(provider);
```

---

### `server/test/tickets-helpers.test.ts` *(new)*

```ts
import { describe, it, expect } from 'vitest';
import { parseTicketRefs, toStatusType, toTicketDto } from '../src/modules/tickets/helpers.js';
import { MAX_TICKET_CANDIDATES } from '../src/modules/tickets/constants.js';
import type { PrTicketRow } from '../src/modules/tickets/repository.js';

/**
 * The property these pin is RESTRAINT plus ORDER. Branch-name parsing is the
 * one place this feature can be confidently wrong, so the load-bearing tests
 * are the ones asserting that an ordinary branch yields nothing, and that the
 * best guess comes first when a branch offers several.
 */

describe('parseTicketRefs', () => {
  it('finds the identifier in a conventional feature branch', () => {
    expect(parseTicketRefs('feat/ENG-482-retry-budget')).toEqual([
      { team: 'ENG', number: 482, identifier: 'ENG-482' },
    ]);
  });

  it("normalises Linear's own lowercase branch name", () => {
    expect(parseTicketRefs('oli/eng-482-retry-budget')).toEqual([
      { team: 'ENG', number: 482, identifier: 'ENG-482' },
    ]);
  });

  it('handles a bare identifier as the whole branch', () => {
    expect(parseTicketRefs('ENG-482')).toEqual([
      { team: 'ENG', number: 482, identifier: 'ENG-482' },
    ]);
  });

  it('strips leading zeros so eng-0482 and ENG-482 are one ticket', () => {
    expect(parseTicketRefs('feat/eng-0482-retry')[0]?.identifier).toBe('ENG-482');
  });

  it('returns nothing for an ordinary branch with no reference', () => {
    expect(parseTicketRefs('feat/rate-limit-public')).toEqual([]);
    expect(parseTicketRefs('main')).toEqual([]);
    expect(parseTicketRefs('release/2026-06-01')).toEqual([]);
  });

  it('does not treat a two-char version suffix as a team key', () => {
    // The key must start with a letter, so `2026-06` and `-01` cannot match.
    expect(parseTicketRefs('release/2026-06-01')).toEqual([]);
  });

  it('prefers the LAST path segment, then the rest of the branch', () => {
    expect(parseTicketRefs('ENG-1/feat/ENG-2-thing').map((r) => r.identifier)).toEqual([
      'ENG-2',
      'ENG-1',
    ]);
  });

  it('de-duplicates a reference that appears twice', () => {
    expect(parseTicketRefs('eng-482/feat/ENG-482-retry').map((r) => r.identifier)).toEqual([
      'ENG-482',
    ]);
  });

  it(`caps candidates at ${MAX_TICKET_CANDIDATES}`, () => {
    const refs = parseTicketRefs('feat/ENG-1-ENG-2-ENG-3-ENG-4-ENG-5');
    expect(refs).toHaveLength(MAX_TICKET_CANDIDATES);
  });

  /* Documents the deliberate false positive: the regex cannot tell `utf-8`
     from a ticket, and must not try — Linear answers null and nothing renders.
     If this ever becomes a real problem the fix is a team-key allowlist, not a
     cleverer regex. */
  it('emits a candidate for utf-8, leaving Linear to reject it', () => {
    expect(parseTicketRefs('chore/fix-utf-8-encoding').map((r) => r.identifier)).toEqual(['UTF-8']);
  });
});

describe('toStatusType', () => {
  it('passes a known Linear state category through', () => {
    expect(toStatusType('started')).toBe('started');
    expect(toStatusType('canceled')).toBe('canceled');
  });

  it('maps anything unrecognised to unknown rather than guessing', () => {
    expect(toStatusType('someFutureCategory')).toBe('unknown');
    expect(toStatusType('')).toBe('unknown');
  });
});

describe('toTicketDto', () => {
  const row: PrTicketRow = {
    prId: '00000000-0000-0000-0000-000000000001',
    provider: 'linear',
    identifier: 'ENG-482',
    title: 'Add a retry budget to the webhook dispatcher',
    statusName: 'In Review',
    statusType: 'started',
    url: 'https://linear.app/acme/issue/ENG-482',
    assignee: 'marisa.koch',
    issueUpdatedAt: new Date('2026-06-01T03:00:00.000Z'),
    fetchedAt: new Date('2026-06-01T04:00:00.000Z'),
  };

  it('maps a row onto the wire DTO with ISO timestamps', () => {
    expect(toTicketDto(row, false)).toEqual({
      provider: 'linear',
      identifier: 'ENG-482',
      title: 'Add a retry budget to the webhook dispatcher',
      status: 'In Review',
      status_type: 'started',
      url: 'https://linear.app/acme/issue/ENG-482',
      assignee: 'marisa.koch',
      updated_at: '2026-06-01T03:00:00.000Z',
      fetched_at: '2026-06-01T04:00:00.000Z',
      stale: false,
    });
  });

  it('carries the caller-supplied stale flag rather than deriving it', () => {
    expect(toTicketDto(row, true).stale).toBe(true);
  });
});
```

---

### `server/test/tickets.it.test.ts` *(new)*

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import { MockLinearClient, MockGitHubClient, MockGitClient, MockEmbedder } from '../src/adapters/mocks.js';
import * as t from '../src/db/schema.js';

/**
 * Linear ticket context, end to end against a real Postgres.
 *
 * The load-bearing assertions are the ones a unit test cannot make:
 *   • a resolved ticket is PERSISTED, and the second read does not call Linear
 *   • an outage serves the cached row flagged `stale`, never a 5xx
 *   • a branch renamed onto a DIFFERENT ticket never serves the old row
 *   • a branch with no reference costs zero Linear calls
 */

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const config = () => loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);

let repoSeq = 0;
async function setupPr(db: PgFixture['handle']['db'], workspaceId: string, branch: string) {
  const name = `tickets-api-${repoSeq++}`;
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
      title: 'Add a retry budget to the webhook dispatcher',
      author: 'marisa.koch',
      branch,
      base: 'main',
      headSha: 'a1b2c3d4',
      additions: 1,
      deletions: 0,
      filesCount: 1,
      status: 'needs_review',
    })
    .returning();
  return { repo: repo!, pr: pr! };
}

d('Linear ticket context (Testcontainers pg)', () => {
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

  /* Every adapter this path can reach is injected. An un-injected one falls
     through to LocalSecretsProvider and can make a real, billed network call
     without failing loudly (see INSIGHTS 2026-08-11). */
  function appWith(linear: MockLinearClient) {
    return buildApp({
      config: config(),
      db: pg.handle.db,
      overrides: {
        linear,
        github: new MockGitHubClient(),
        git: new MockGitClient(),
        embedder: new MockEmbedder(),
      },
    });
  }

  it('resolves the ticket from the branch, returns it, and persists it', async () => {
    const linear = new MockLinearClient();
    const app = await appWith(linear);
    const { pr } = await setupPr(pg.handle.db, workspaceId, 'feat/ENG-482-retry-budget');

    const res = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/ticket` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.identifier).toBe('ENG-482');
    expect(body.title).toBe('Add a retry budget to the webhook dispatcher');
    expect(body.status).toBe('In Review');
    expect(body.status_type).toBe('started');
    expect(body.stale).toBe(false);

    const [row] = await pg.handle.db
      .select()
      .from(t.prTickets)
      .where(eq(t.prTickets.prId, pr.id));
    expect(row?.identifier).toBe('ENG-482');
    expect(row?.statusName).toBe('In Review');
    await app.close();
  });

  it('serves the second read from cache without calling Linear again', async () => {
    const linear = new MockLinearClient();
    const app = await appWith(linear);
    const { pr } = await setupPr(pg.handle.db, workspaceId, 'oli/eng-482-retry-budget');

    await app.inject({ method: 'GET', url: `/pulls/${pr.id}/ticket` });
    expect(linear.lookups).toHaveLength(1);
    const second = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/ticket` });
    expect(second.json().identifier).toBe('ENG-482');
    expect(linear.lookups).toHaveLength(1);

    // ?refresh=true is the escape hatch from the TTL.
    await app.inject({ method: 'GET', url: `/pulls/${pr.id}/ticket?refresh=true` });
    expect(linear.lookups).toHaveLength(2);
    await app.close();
  });

  it('costs zero Linear calls for a branch that names no ticket', async () => {
    const linear = new MockLinearClient();
    const app = await appWith(linear);
    const { pr } = await setupPr(pg.handle.db, workspaceId, 'feat/rate-limit-public');

    const res = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/ticket` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toBeNull();
    expect(linear.lookups).toHaveLength(0);
    await app.close();
  });

  it('returns null (not a ticket) when the candidate is a false positive', async () => {
    const linear = new MockLinearClient({ issues: {} });
    const app = await appWith(linear);
    const { pr } = await setupPr(pg.handle.db, workspaceId, 'chore/fix-utf-8-encoding');

    const res = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/ticket` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toBeNull();
    expect(linear.lookups.map((l) => l.identifier)).toEqual(['UTF-8']);
    await app.close();
  });

  it('serves the cached ticket flagged stale when Linear is down', async () => {
    const { pr } = await setupPr(pg.handle.db, workspaceId, 'feat/ENG-482-retry-budget');

    const ok = await appWith(new MockLinearClient());
    await ok.inject({ method: 'GET', url: `/pulls/${pr.id}/ticket` });
    await ok.close();

    const down = await appWith(new MockLinearClient({ fail: new Error('linear is down') }));
    const res = await down.inject({ method: 'GET', url: `/pulls/${pr.id}/ticket?refresh=true` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.identifier).toBe('ENG-482');
    expect(body.status).toBe('In Review');
    expect(body.stale).toBe(true);
    await down.close();
  });

  it('returns null when Linear is down and nothing was ever cached', async () => {
    const down = await appWith(new MockLinearClient({ fail: new Error('linear is down') }));
    const { pr } = await setupPr(pg.handle.db, workspaceId, 'feat/ENG-482-retry-budget');

    const res = await down.inject({ method: 'GET', url: `/pulls/${pr.id}/ticket` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toBeNull();
    await down.close();
  });

  /* The rule that makes the cache safe: a row belongs to an IDENTIFIER, not to
     a PR. Serving ENG-482 for a branch that now says ENG-501 would be a
     confident wrong answer. */
  it('never serves a cached ticket the branch no longer names', async () => {
    const { pr } = await setupPr(pg.handle.db, workspaceId, 'feat/ENG-482-retry-budget');
    const ok = await appWith(new MockLinearClient());
    await ok.inject({ method: 'GET', url: `/pulls/${pr.id}/ticket` });
    await ok.close();

    await pg.handle.db
      .update(t.pullRequests)
      .set({ branch: 'feat/ENG-501-something-else' })
      .where(eq(t.pullRequests.id, pr.id));

    const down = await appWith(new MockLinearClient({ fail: new Error('linear is down') }));
    const res = await down.inject({ method: 'GET', url: `/pulls/${pr.id}/ticket` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toBeNull();
    await down.close();
  });

  it('404s an unknown PR', async () => {
    const app = await appWith(new MockLinearClient());
    const res = await app.inject({
      method: 'GET',
      url: '/pulls/00000000-0000-0000-0000-0000000000ff/ticket',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
    await app.close();
  });
});
```
