# Linear ticket context on a pull request — implementation plan (`server/`)

## 1. What we are building

When a PR's branch name references a Linear issue (`feat/ENG-482-retry-budget`,
`mari/eng-482-retry-budget`, `ENG-482`), the PR page shows that issue's **title**
and **current status**.

Server scope only. One new endpoint:

```
GET /pulls/:id/ticket   →  PrTicketResult
```

The response always has a shape the UI can render — it never 4xx/5xxs because
Linear is down or unconfigured. It carries a `status` discriminator saying *why*
there is no ticket, in the same spirit as `IntentSource.status/reason` and
`BlastRadius.index.reason`: the UI shows what the system did not know rather
than an empty box.

| `status` | Meaning |
|---|---|
| `ok` | Branch matched a key, Linear resolved it. `ticket` is populated. |
| `no_reference` | The branch contains no plausible Linear key. |
| `not_configured` | A key was parsed, but no `LINEAR_API_KEY` is set. |
| `not_found` | Key parsed, Linear has no such issue (a false-positive parse, or a deleted issue). |
| `unavailable` | Linear errored/timed out and there is no cached copy. |

`stale: true` is returned when Linear was unreachable but a previously cached
row is being served — the same local-first promise `GET /pulls/:id` already
makes when GitHub is offline.

## 2. Layering

Straight down the house onion, mirroring `modules/blast` and `modules/intent`:

```
routes.ts  (zod params, getContext, no logic)
   └─ service.ts       (orchestration, degradation policy, cache freshness)
        ├─ repository.ts   (ONLY layer touching pr_tickets / pull_requests)
        ├─ helpers.ts      (pure: branch → ticket key; row → DTO)
        └─ container.tickets()  → TicketClient port
                                    ├─ prod:  adapters/linear/graphql.ts
                                    └─ tests: adapters/mocks.ts MockTicketClient
```

Decisions, and why:

- **A port, not a direct `fetch`.** Every external call in this codebase sits
  behind an interface in `src/vendor/shared/adapters.ts` and is constructed only
  in `platform/container.ts`. `TicketClient` is deliberately provider-shaped
  (`getTicket(key)`), not Linear-shaped, so a Jira adapter is a second class and
  not a second module.
- **No new npm dependency.** Linear's GraphQL API is one POST; `@linear/sdk`
  would add a dependency to a package with its own lockfile and no workspace
  linking. The adapter uses `fetch` + `withRetry`/`withTimeout` from
  `platform/resilience.ts`, exactly like `OctokitGitHubClient`.
- **Key lookup, not free-text search.** `issues(filter: { team: { key: { eq } }, number: { eq } })`
  is exact. Linear's `issue(id:)` query wants a UUID, and `issueSearch` is fuzzy —
  both would let us show the wrong ticket, which is worse than showing none.
- **Persisted cache, TTL-based (not head-sha-based).** `pr_intent` and `pr_brief`
  invalidate on `head_sha` because they are *derived from the diff*. A ticket's
  status changes on Linear's clock, independent of the PR, so head sha is the
  wrong key. We cache per PR with a short TTL (5 min) and a long TTL for
  negative results (1 h), plus the parsed `branch` as part of the freshness
  check so a re-pointed branch re-resolves immediately.
- **A new table is required.** The "every future-lesson table already exists"
  rule holds for lesson tables; there is no ticket table in `db/schema/**`
  (grep confirms zero occurrences of `ticket` in `server/src`). So: one new
  schema file, one generated migration.
- **Secrets need no code change.** `LocalSecretsProvider.get` falls through to
  `process.env[key]` for any unknown key, so `LINEAR_API_KEY` works from
  `~/.devdigest/secrets.json` (mode 0600) or the environment on day one.

## 3. Deliberately out of scope

- **Settings UI / `POST /settings/test-connection` for Linear.** That means
  widening `ConnTestProvider`, `SecretsStatus` and `SECRET_KEY_BY_PROVIDER`,
  which are in `contracts/platform.ts` — a file vendored byte-identically into
  `client/src/vendor/shared/`, so it is a synchronized multi-package edit plus a
  client panel. Not needed to show ticket context; listed here as the obvious
  follow-up.
- **The client panel.** Server-only task. When the UI lands, the new
  `contracts/tickets.ts` file and the `adapters.ts` addition below must be
  copied verbatim into `client/src/vendor/shared/` (the two vendored trees are
  currently identical; there is no sync script, it is done by hand).
- **Feeding the ticket into the reviewer prompt.** A separate decision with its
  own grounding implications (a Linear description is untrusted text and would
  need `wrapUntrusted`). Not part of "show it on the PR page".

## 4. Files

| File | Change |
|---|---|
| `server/src/vendor/shared/contracts/tickets.ts` | **new** — DTOs |
| `server/src/vendor/shared/index.ts` | edit — one barrel line |
| `server/src/vendor/shared/adapters.ts` | edit — `TicketClient` port |
| `server/src/adapters/linear/graphql.ts` | **new** — Linear adapter |
| `server/src/adapters/index.ts` | edit — one export |
| `server/src/adapters/mocks.ts` | edit — `MockTicketClient` |
| `server/src/platform/container.ts` | edit — `tickets()` + override + cache invalidation |
| `server/src/db/schema/tickets.ts` | **new** — `pr_tickets` |
| `server/src/db/schema.ts` | edit — barrel + `schema` object |
| `server/src/db/migrations/0017_pr_tickets.sql` | **new** — generated |
| `server/src/modules/tickets/constants.ts` | **new** |
| `server/src/modules/tickets/helpers.ts` | **new** |
| `server/src/modules/tickets/repository.ts` | **new** |
| `server/src/modules/tickets/service.ts` | **new** |
| `server/src/modules/tickets/routes.ts` | **new** |
| `server/src/modules/index.ts` | edit — one import + one entry |
| `server/test/tickets-helpers.test.ts` | **new** — unit |
| `server/test/tickets.it.test.ts` | **new** — integration |

## 5. Verification

```
cd server
pnpm db:generate            # emits 0017 + meta/0017_snapshot.json + journal entry
pnpm db:migrate
pnpm typecheck
pnpm exec vitest run --exclude '**/*.it.test.ts'
pnpm exec vitest run .it.test          # needs Docker
```

Do **not** hand-write `src/db/migrations/meta/_journal.json` or the snapshot —
`drizzle-kit generate` owns both. The SQL below is what the generate is expected
to emit; if it differs, keep drizzle-kit's output. This migration is pure
additions (one new table), so it will not hit the interactive
"created or renamed?" prompt recorded in `server/INSIGHTS.md`.

---

# `server/src/vendor/shared/contracts/tickets.ts`

```ts
import { z } from 'zod';

/**
 * Issue-tracker ticket context for a pull request.
 *
 * The reference is derived from the PR's BRANCH NAME (e.g.
 * `feat/ENG-482-retry-budget` → `ENG-482`), so it exists whether or not the
 * tracker is reachable — which is why `reference` and `ticket` are separate
 * fields. A branch can name a ticket we cannot currently resolve.
 *
 * Snake_case, like every other DTO here; the Drizzle row is camelCase and the
 * module's `helpers.toResult` is the one mapper between them.
 */

/** Trackers we know how to resolve. Only Linear today. */
export const TicketProviderId = z.enum(['linear']);
export type TicketProviderId = z.infer<typeof TicketProviderId>;

/** What the branch name pointed at, before (or without) any lookup. */
export const TicketRef = z.object({
  provider: TicketProviderId,
  /** Human key as Linear shows it, always upper-cased: `ENG-482`. */
  key: z.string(),
  /** The branch the key was parsed out of — shown so a wrong match is debuggable. */
  branch: z.string(),
});
export type TicketRef = z.infer<typeof TicketRef>;

/**
 * A workflow state. `name` is the workspace's own label ("In Review"), `type`
 * is Linear's stable category (`triage|backlog|unstarted|started|completed|canceled`)
 * — render colour and "is it done" semantics off `type`, never off the free-text `name`.
 */
export const TicketState = z.object({
  name: z.string(),
  type: z.string(),
});
export type TicketState = z.infer<typeof TicketState>;

export const Ticket = z.object({
  provider: TicketProviderId,
  key: z.string(),
  title: z.string(),
  url: z.string(),
  state: TicketState,
});
export type Ticket = z.infer<typeof Ticket>;

/**
 * Why the response has (or has not) a ticket. Everything except `ok` is a
 * normal outcome with an empty-state to render — none of them is an error.
 *
 *  - `no_reference`   the branch names no ticket
 *  - `not_configured` a key was parsed but LINEAR_API_KEY is unset
 *  - `not_found`      Linear has no such issue (usually a false-positive parse)
 *  - `unavailable`    Linear errored/timed out and nothing was cached
 */
export const PrTicketStatus = z.enum([
  'ok',
  'no_reference',
  'not_configured',
  'not_found',
  'unavailable',
]);
export type PrTicketStatus = z.infer<typeof PrTicketStatus>;

export const PrTicketResult = z.object({
  status: PrTicketStatus,
  reference: TicketRef.nullable(),
  ticket: Ticket.nullable(),
  /** When the ticket was last read from Linear (ISO), null if never. */
  fetched_at: z.string().nullable(),
  /** True ⇒ Linear was unreachable and this is a previously cached copy. */
  stale: z.boolean(),
});
export type PrTicketResult = z.infer<typeof PrTicketResult>;
```

---

# `server/src/vendor/shared/index.ts`

Add one export line to the barrel (rest of the file unchanged):

```ts
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

---

# `server/src/vendor/shared/adapters.ts`

Append a new section at the end of the file (everything above is unchanged).
The port is provider-neutral on purpose: a Jira adapter implements the same
interface and nothing in `modules/tickets` changes.

```ts
// ---------- Issue tracker (Linear) ----------

/** One workflow state. `type` is the stable category; `name` is the label. */
export interface TicketStateInfo {
  name: string;
  type: string;
}

/** A resolved tracker issue. Mirrors the `Ticket` contract. */
export interface TicketInfo {
  provider: 'linear';
  /** Human key, upper-cased: `ENG-482`. */
  key: string;
  title: string;
  url: string;
  state: TicketStateInfo;
}

/**
 * Issue-tracker read port. Deliberately narrow — the PR page needs a title and
 * a status, nothing else — and deliberately keyed by the HUMAN identifier,
 * because that is the only thing a branch name can carry.
 */
export interface TicketClient {
  readonly provider: 'linear';
  /**
   * Resolve one issue by key. Returns `null` when the tracker answers
   * successfully but has no such issue (a false-positive branch parse is the
   * common case) — that is a normal outcome, not an error. Throws only when the
   * tracker itself failed: bad credentials, 5xx, timeout.
   */
  getTicket(key: string): Promise<TicketInfo | null>;
}
```

---

# `server/src/adapters/linear/graphql.ts`

```ts
import { z } from 'zod';
import type { TicketClient, TicketInfo } from '@devdigest/shared';
import { withRetry, withTimeout } from '../../platform/resilience.js';
import { ExternalServiceError } from '../../platform/errors.js';

const LINEAR_API_URL = 'https://api.linear.app/graphql';
const TIMEOUT = 15_000;

/**
 * Exact lookup by team key + issue number.
 *
 * `issue(id:)` takes a UUID, not `ENG-482`, and `issueSearch` is fuzzy — either
 * one can hand back a DIFFERENT issue than the branch named, which is worse
 * than showing nothing. The `issues` filter is an equality match on both halves
 * of the identifier, so it either returns that issue or nothing.
 */
const ISSUE_QUERY = `
  query DevDigestIssue($teamKey: String!, $number: Float!) {
    issues(
      filter: { team: { key: { eq: $teamKey } }, number: { eq: $number } }
      first: 1
    ) {
      nodes {
        identifier
        title
        url
        state { name type }
      }
    }
  }
`;

/**
 * Response validated rather than cast: this is third-party JSON, and an
 * unexpected shape should fail here with a readable message instead of
 * surfacing as `undefined.title` three layers up.
 */
const IssueResponse = z.object({
  data: z
    .object({
      issues: z.object({
        nodes: z.array(
          z.object({
            identifier: z.string(),
            title: z.string(),
            url: z.string(),
            state: z.object({ name: z.string(), type: z.string() }).nullish(),
          }),
        ),
      }),
    })
    .nullish(),
  errors: z.array(z.object({ message: z.string() })).nullish(),
});

/** `ENG-482` → `{ teamKey: 'ENG', number: 482 }`. */
function splitKey(key: string): { teamKey: string; number: number } | null {
  const m = /^([A-Za-z]{2,5})-(\d{1,6})$/.exec(key.trim());
  if (!m) return null;
  return { teamKey: m[1]!.toUpperCase(), number: Number(m[2]) };
}

/**
 * Linear personal API keys (`lin_api_…`) are sent RAW in `Authorization`;
 * OAuth access tokens use the `Bearer` prefix. Guessing wrong is a 401 with no
 * hint, so branch on the documented prefix.
 */
function authHeader(apiKey: string): string {
  return apiKey.startsWith('lin_oauth_') ? `Bearer ${apiKey}` : apiKey;
}

/**
 * `TicketClient` over Linear's GraphQL API — thin, one query.
 *
 * No SDK: `@linear/sdk` would be a new dependency in a package with its own
 * lockfile, to save one `fetch`. Timeout + retry come from the shared
 * resilience helpers, same as `OctokitGitHubClient`.
 */
export class LinearTicketClient implements TicketClient {
  readonly provider = 'linear' as const;

  constructor(private readonly apiKey: string) {}

  async getTicket(key: string): Promise<TicketInfo | null> {
    const parts = splitKey(key);
    // A malformed key is the caller's bug, not Linear's: don't spend a request.
    if (!parts) return null;

    const body = await withRetry(() =>
      withTimeout(
        (async () => {
          const res = await fetch(LINEAR_API_URL, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: authHeader(this.apiKey),
            },
            body: JSON.stringify({
              query: ISSUE_QUERY,
              variables: { teamKey: parts.teamKey, number: parts.number },
            }),
          });
          if (!res.ok) {
            // Carry the status so `withRetry`'s default predicate can retry
            // 429/5xx and stop on a 401.
            const err = new Error(`Linear API returned ${res.status}`) as Error & {
              status: number;
            };
            err.status = res.status;
            throw err;
          }
          return res.json() as Promise<unknown>;
        })(),
        TIMEOUT,
      ),
    );

    const parsed = IssueResponse.safeParse(body);
    if (!parsed.success) {
      throw new ExternalServiceError('Linear returned an unexpected response shape');
    }
    // GraphQL reports auth/validation failures as HTTP 200 + `errors`.
    if (parsed.data.errors?.length) {
      throw new ExternalServiceError(`Linear: ${parsed.data.errors[0]!.message}`);
    }

    const node = parsed.data.data?.issues.nodes[0];
    if (!node) return null;

    return {
      provider: 'linear',
      key: node.identifier,
      title: node.title,
      url: node.url,
      // A state is always present on a real issue; default rather than throw so
      // one odd row cannot blank the whole card.
      state: { name: node.state?.name ?? 'Unknown', type: node.state?.type ?? 'unknown' },
    };
  }
}
```

---

# `server/src/adapters/index.ts`

```ts
/** Adapter barrel — real + mock implementations behind the adapter interfaces. */
export { LocalSecretsProvider } from './secrets/local.js';
export { LocalNoAuthProvider } from './auth/local.js';
export { OpenAIProvider } from './llm/openai.js';
export { AnthropicProvider } from './llm/anthropic.js';
export { OpenAIEmbedder } from './embedder/openai.js';
export { OctokitGitHubClient } from './github/octokit.js';
export { LinearTicketClient } from './linear/graphql.js';
export { SimpleGitClient } from './git/simple-git.js';
export { parseUnifiedDiff } from './git/diff-parser.js';
export { RipgrepCodeIndex } from './codeindex/ripgrep.js';
export { estimateCost } from './llm/pricing.js';
export * from './mocks.js';
```

---

# `server/src/adapters/mocks.ts`

Add `TicketClient` / `TicketInfo` to the existing type-only import block, then
append the mock next to `MockCodeIndex` (rest of the file unchanged):

```ts
// ...existing import list, extended:
import type {
  // …
  TicketClient,
  TicketInfo,
} from '@devdigest/shared';

// ---------- Mock Ticket client ----------
export interface MockTicketOptions {
  /** Issues by KEY (case-insensitive); anything else resolves to null. */
  tickets?: Record<string, TicketInfo>;
  /** When set, every call rejects with it — the "Linear is down" path. */
  error?: Error;
}

/**
 * Deterministic TicketClient. `calls` is public so a test can assert the cache
 * actually prevented a second lookup — the assertion that a TTL is real.
 */
export class MockTicketClient implements TicketClient {
  readonly provider = 'linear' as const;
  public calls: string[] = [];

  constructor(private opts: MockTicketOptions = {}) {}

  async getTicket(key: string): Promise<TicketInfo | null> {
    this.calls.push(key);
    if (this.opts.error) throw this.opts.error;
    const found = this.opts.tickets?.[key.toUpperCase()];
    if (found) return found;
    if (key.toUpperCase() === 'ENG-482') {
      return {
        provider: 'linear',
        key: 'ENG-482',
        title: 'Retry budget for the public API',
        url: 'https://linear.app/acme/issue/ENG-482',
        state: { name: 'In Review', type: 'started' },
      };
    }
    return null;
  }
}
```

---

# `server/src/platform/container.ts`

Three edits. Imports:

```ts
import type {
  AuthProvider,
  SecretsProvider,
  GitHubClient,
  GitClient,
  CodeIndex,
  Embedder,
  LLMProvider,
  TicketClient,
} from '@devdigest/shared';
// …
import { LinearTicketClient } from '../adapters/linear/graphql.js';
```

`ContainerOverrides` gains a slot:

```ts
  /** repo-intel T3 adapters — only the indexer pipeline reads these. */
  depgraph?: DepGraph;
  tokenizer?: Tokenizer;
  /** Issue-tracker port (Linear). Tests inject MockTicketClient. */
  tickets?: TicketClient;
}
```

A private field beside `_github`, the accessor next to `github()`, and one line
in `invalidateSecretCaches`:

```ts
  private _github?: GitHubClient;
  private _tickets?: TicketClient;

  // …

  /**
   * Issue-tracker client. Async + key-gated exactly like `github()`: the key
   * lives in SecretsProvider, never AppConfig, and a missing key is a
   * `ConfigError` the caller is expected to CATCH — `TicketsService` turns it
   * into a `not_configured` response rather than a 500, because "you haven't
   * connected Linear" is a UI state, not a server fault.
   */
  async tickets(): Promise<TicketClient> {
    if (this.overrides.tickets) return this.overrides.tickets;
    if (this._tickets) return this._tickets;
    const key = await this.secrets.get('LINEAR_API_KEY');
    if (!key) throw new ConfigError('LINEAR_API_KEY is not configured');
    this._tickets = new LinearTicketClient(key);
    return this._tickets;
  }

  // …

  invalidateSecretCaches(): void {
    this.llmCache.clear();
    this._github = undefined;
    this._tickets = undefined;
    this._embedder = undefined;
  }
```

---

# `server/src/db/schema/tickets.ts`

```ts
import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';
import { pullRequests } from './pulls';

/**
 * Cached issue-tracker context for one PR — one row per PR, keyed by the PR id,
 * the same single-row-per-PR shape as `pr_intent` / `pr_brief`.
 *
 * FRESHNESS IS TIME-BASED, NOT HEAD-SHA-BASED. `pr_intent` and `pr_brief`
 * invalidate on `head_sha` because they are derived from the diff; a ticket's
 * title and status change on the TRACKER's clock, independently of the PR, so
 * a head sha would pin a stale status forever on a quiet PR. `branch` is stored
 * alongside so a re-pointed branch re-resolves immediately regardless of TTL.
 *
 * `status` also caches NEGATIVE results (`not_found`): a branch like
 * `fix/add-2-retries` can parse to a plausible key that Linear does not have,
 * and without a negative cache every page load would pay a network round trip
 * to learn that again.
 *
 * NOTE: no `workspace_id`. The row hangs off `pull_requests`, which carries it,
 * and every read goes through a workspace-scoped PR guard in the repository —
 * the same arrangement `pr_intent` uses.
 */
export const prTickets = pgTable('pr_tickets', {
  prId: uuid('pr_id')
    .primaryKey()
    .references(() => pullRequests.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull().default('linear'),
  /** Upper-cased human key: `ENG-482`. */
  ticketKey: text('ticket_key').notNull(),
  /** Branch the key was parsed from; a change invalidates the row. */
  branch: text('branch').notNull(),
  /** `ok` (title/url/state populated) or `not_found` (negative cache). */
  status: text('status', { enum: ['ok', 'not_found'] }).notNull(),
  title: text('title'),
  url: text('url'),
  /** Workspace label ("In Review"). */
  stateName: text('state_name'),
  /** Linear's stable category (started/completed/…). Render off this, not the name. */
  stateType: text('state_type'),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).defaultNow().notNull(),
});
```

---

# `server/src/db/schema.ts`

Two additions: the `export *` line with the other domain files, and the import +
entry in the `schema` object.

```ts
export * from './schema/core';
export * from './schema/repos';
export * from './schema/pulls';
export * from './schema/reviews';
export * from './schema/tickets';
export * from './schema/skills';
// …rest unchanged

import { pullRequests, prFiles, prCommits } from './schema/pulls';
import { prTickets } from './schema/tickets';
// …rest unchanged

export const schema = {
  // …
  prFiles,
  prCommits,
  prTickets,
  reviews,
  // …rest unchanged
};
```

---

# `server/src/db/migrations/0017_pr_tickets.sql`

Produced by `pnpm db:generate` (which also writes `meta/0017_*_snapshot.json`
and the `_journal.json` entry — do not hand-write those). Expected content:

```sql
CREATE TABLE "pr_tickets" (
	"pr_id" uuid PRIMARY KEY NOT NULL,
	"provider" text DEFAULT 'linear' NOT NULL,
	"ticket_key" text NOT NULL,
	"branch" text NOT NULL,
	"status" text NOT NULL,
	"title" text,
	"url" text,
	"state_name" text,
	"state_type" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pr_tickets" ADD CONSTRAINT "pr_tickets_pr_id_pull_requests_id_fk" FOREIGN KEY ("pr_id") REFERENCES "public"."pull_requests"("id") ON DELETE cascade ON UPDATE no action;
```

---

# `server/src/modules/tickets/constants.ts`

```ts
/**
 * Tunables for the ticket-context module.
 *
 * Everything here bounds two things: how eagerly we call Linear, and how
 * willing the branch parser is to claim a match. The parser is the risky half —
 * a wrong ticket shown confidently on a PR is worse than no ticket at all — so
 * its constants lean strict.
 */

/** How long a successfully-resolved ticket is served from cache. */
export const TICKET_TTL_MS = 5 * 60_000;

/**
 * How long a `not_found` is cached. Much longer than a hit: the overwhelmingly
 * common cause is a false-positive branch parse, which will never resolve, and
 * re-asking Linear on every page load costs a round trip to learn nothing.
 */
export const NOT_FOUND_TTL_MS = 60 * 60_000;

/**
 * Team-key shape. Linear team keys are short and alphabetic; requiring
 * LETTERS ONLY (no digits) is what stops `release/v2-3-hotfix` from parsing as
 * ticket `V2-3`. Two chars minimum kills `x-1`.
 */
export const TEAM_KEY_MIN = 2;
export const TEAM_KEY_MAX = 5;

/**
 * Tokens that match the shape but are never Linear teams. This list is a
 * politeness, not the safety net — the safety net is that an unresolvable key
 * comes back `not_found` and shows nothing. Keep it short and boring; do not
 * grow it into a denylist that pretends to be validation.
 */
export const NON_TICKET_KEYS: readonly string[] = [
  'FIX',
  'ADD',
  'PART',
  'STEP',
  'WIP',
  'UTF',
  'ISO',
  'SHA',
  'RFC',
  'IPV',
  'HTTP',
  'PR',
  'GH',
];
```

---

# `server/src/modules/tickets/helpers.ts`

```ts
import type { PrTicketResult, Ticket, TicketRef } from '@devdigest/shared';
import type { PrTicketRow } from './repository.js';
import { NON_TICKET_KEYS, TEAM_KEY_MAX, TEAM_KEY_MIN } from './constants.js';

/**
 * Branch-name → Linear key, and cached row → response DTO. Pure; no db, no
 * network, no container — everything here is unit-tested without a fixture.
 */

/**
 * A key is a `TEAM-123` token delimited by a branch separator or a string
 * boundary. Two deliberate narrowings:
 *
 *  - the team key is LETTERS ONLY (`[A-Za-z]{2,5}`), so `release/v2-3-hotfix`
 *    does not parse as `V2-3`;
 *  - the token must be bounded by `/`, `-`, `_`, `.` or the string end, so
 *    `retry-budget-2` (a suffix, not a reference) does not match mid-word.
 *
 * It is still a heuristic — `fix/add-2-retries` matches shape — which is why
 * the service treats an unresolvable key as `not_found` rather than an error,
 * and why `NON_TICKET_KEYS` filters the obvious English ones.
 */
const TICKET_RE = new RegExp(
  `(?:^|[/_.-])([A-Za-z]{${TEAM_KEY_MIN},${TEAM_KEY_MAX}})-(\\d{1,6})(?=$|[/_.-])`,
  'g',
);

/**
 * The first plausible ticket key in a branch name, upper-cased — or null.
 *
 * When several tokens match, an UPPER-CASE one wins over a lower-case one:
 * `ENG-482` in `feat/ENG-482-retry-budget` is an unambiguous, deliberately
 * typed reference, whereas a lower-case match is often just English
 * (`fix/add-2-retries`). Within the same case class, the leftmost wins.
 */
export function parseTicketKey(branch: string): string | null {
  if (!branch) return null;
  const upper: string[] = [];
  const lower: string[] = [];
  for (const m of branch.matchAll(TICKET_RE)) {
    const team = m[1]!;
    const number = m[2]!;
    if (NON_TICKET_KEYS.includes(team.toUpperCase())) continue;
    // Leading zeros are not how Linear numbers issues (`ENG-007` is not 7).
    if (number.length > 1 && number.startsWith('0')) continue;
    const key = `${team.toUpperCase()}-${number}`;
    (team === team.toUpperCase() ? upper : lower).push(key);
  }
  return upper[0] ?? lower[0] ?? null;
}

/** The branch-derived reference — known even when the tracker is unreachable. */
export function toReference(branch: string, key: string): TicketRef {
  return { provider: 'linear', key, branch };
}

/** A cached `ok` row → the public `Ticket`. Returns null for a negative row. */
export function rowToTicket(row: PrTicketRow): Ticket | null {
  if (row.status !== 'ok' || !row.title || !row.url) return null;
  return {
    provider: 'linear',
    key: row.ticketKey,
    title: row.title,
    url: row.url,
    state: { name: row.stateName ?? 'Unknown', type: row.stateType ?? 'unknown' },
  };
}

/** A cached row → the full response. `stale` is the caller's call, not the row's. */
export function rowToResult(row: PrTicketRow, stale: boolean): PrTicketResult {
  const ticket = rowToTicket(row);
  return {
    status: ticket ? 'ok' : 'not_found',
    reference: toReference(row.branch, row.ticketKey),
    ticket,
    fetched_at: row.fetchedAt.toISOString(),
    stale,
  };
}

/** A response with no ticket body — the `no_reference`/`not_configured`/`unavailable` shapes. */
export function emptyResult(
  status: PrTicketResult['status'],
  reference: TicketRef | null,
): PrTicketResult {
  return { status, reference, ticket: null, fetched_at: null, stale: false };
}
```

---

# `server/src/modules/tickets/repository.ts`

```ts
import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';
import type { PullRow } from '../../db/rows.js';

/**
 * Ticket data-access. The ONLY layer touching `pr_tickets`.
 *
 * The workspace-scoped PR guard is duplicated from the blast/intent
 * repositories on purpose, per the house rule those two already state: a module
 * never reaches into another module's folder, and a plain workspace-scoped row
 * read is not another module's business logic.
 */

export type PrTicketRow = typeof t.prTickets.$inferSelect;

/** Everything one resolution writes. `prId` is the conflict target (the PK). */
export interface UpsertPrTicket {
  prId: string;
  ticketKey: string;
  branch: string;
  status: 'ok' | 'not_found';
  title: string | null;
  url: string | null;
  stateName: string | null;
  stateType: string | null;
}

export class TicketsRepository {
  constructor(private db: Db) {}

  /** Workspace-scoped PR guard — `undefined` means "not in this workspace" (404). */
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
   * One row per PR: a re-resolve overwrites in place, so `pr_tickets` never
   * accumulates history. `fetched_at` is bumped explicitly because the column
   * default only applies on insert — the same trap `pr_intent.generated_at`
   * documents.
   */
  async upsert(values: UpsertPrTicket): Promise<PrTicketRow> {
    const set = {
      provider: 'linear',
      ticketKey: values.ticketKey,
      branch: values.branch,
      status: values.status,
      title: values.title,
      url: values.url,
      stateName: values.stateName,
      stateType: values.stateType,
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

# `server/src/modules/tickets/service.ts`

```ts
import type { PrTicketResult, TicketClient, TicketInfo } from '@devdigest/shared';
import type { Container } from '../../platform/container.js';
import { NotFoundError } from '../../platform/errors.js';
import { TicketsRepository, type PrTicketRow } from './repository.js';
import { emptyResult, parseTicketKey, rowToResult, toReference } from './helpers.js';
import { NOT_FOUND_TTL_MS, TICKET_TTL_MS } from './constants.js';

/** Minimal structured-log sink, satisfied by Fastify's `req.log.warn`. */
export type TicketLogger = (obj: Record<string, unknown>, msg: string) => void;

export interface TicketOptions {
  /** Bypass the TTL and re-read from the tracker. */
  refresh?: boolean;
  log?: TicketLogger;
}

/**
 * Issue-tracker context for one PR.
 *
 * The whole module is LOCAL-FIRST, matching `GET /pulls/:id`: an unconfigured,
 * unreachable or slow Linear degrades to a well-formed response with a `status`
 * explaining why, never to a 4xx/5xx. The only error this service raises is a
 * 404 for a PR that is not in the caller's workspace.
 *
 * Nothing here calls a model. The ticket is fetched, not inferred, so there is
 * no grounding gate to apply and no cost to attribute.
 */
export class TicketsService {
  private repo: TicketsRepository;

  constructor(private container: Container) {
    this.repo = new TicketsRepository(container.db);
  }

  async getForPull(
    workspaceId: string,
    prId: string,
    opts: TicketOptions = {},
  ): Promise<PrTicketResult> {
    const pull = await this.repo.getPull(workspaceId, prId);
    if (!pull) throw new NotFoundError('Pull request not found');

    const key = parseTicketKey(pull.branch);
    if (!key) return emptyResult('no_reference', null);

    const reference = toReference(pull.branch, key);
    const cached = await this.repo.getByPr(prId);

    if (!opts.refresh && cached && this.isFresh(cached, key, pull.branch)) {
      return rowToResult(cached, false);
    }

    // A missing key is a UI state ("connect Linear"), not a server fault — so
    // the ConfigError from the container is caught, not propagated.
    let client: TicketClient;
    try {
      client = await this.container.tickets();
    } catch (err) {
      opts.log?.({ err: (err as Error).message, key }, 'Linear not configured; no ticket context');
      return cached
        ? rowToResult(cached, true)
        : emptyResult('not_configured', reference);
    }

    let ticket: TicketInfo | null;
    try {
      ticket = await client.getTicket(key);
    } catch (err) {
      // Serve the last known good answer rather than nothing — the same promise
      // the pulls module makes when GitHub is offline.
      opts.log?.({ err: (err as Error).message, key }, 'Linear lookup failed; serving cache');
      return cached ? rowToResult(cached, true) : emptyResult('unavailable', reference);
    }

    const row = await this.repo.upsert({
      prId,
      // Trust the tracker's own casing of the identifier once it has answered.
      ticketKey: ticket?.key ?? key,
      branch: pull.branch,
      status: ticket ? 'ok' : 'not_found',
      title: ticket?.title ?? null,
      url: ticket?.url ?? null,
      stateName: ticket?.state.name ?? null,
      stateType: ticket?.state.type ?? null,
    });
    return rowToResult(row, false);
  }

  /**
   * A cached row is usable when it describes the SAME key parsed from the SAME
   * branch and is inside its TTL. Negative rows get a much longer TTL: they are
   * usually a false-positive branch parse, which will never start resolving.
   */
  private isFresh(row: PrTicketRow, key: string, branch: string): boolean {
    if (row.ticketKey !== key || row.branch !== branch) return false;
    const ttl = row.status === 'ok' ? TICKET_TTL_MS : NOT_FOUND_TTL_MS;
    return Date.now() - row.fetchedAt.getTime() < ttl;
  }
}
```

---

# `server/src/modules/tickets/routes.ts`

```ts
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { PrTicketResult } from '@devdigest/shared';
import { getContext } from '../_shared/context.js';
import { IdParams } from '../_shared/schemas.js';
import { TicketsService } from './service.js';

/**
 * Tickets module.
 *   GET /pulls/:id/ticket → the Linear issue named by the PR's branch
 *
 * Always 200 for a PR in the workspace: "no ticket" and "Linear is down" are
 * `status` values, not error codes, so the Overview panel renders an honest
 * empty state instead of an error boundary. The only 404 is a PR that does not
 * exist in this workspace.
 *
 * A cache miss makes ONE external call, so — unlike the purely local
 * `/pulls/:id/blast` — this route carries a rate limit.
 */

const RefreshQuery = z.object({
  /** Bypass the cache TTL and re-read from Linear. */
  refresh: z.coerce.boolean().optional(),
});

export default async function ticketsRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const service = new TicketsService(app.container);

  app.get(
    '/pulls/:id/ticket',
    {
      schema: { params: IdParams, querystring: RefreshQuery },
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (req): Promise<PrTicketResult> => {
      const { workspaceId } = await getContext(app.container, req);
      return service.getForPull(workspaceId, req.params.id, {
        refresh: req.query.refresh,
        log: (obj, msg) => req.log.warn(obj, msg),
      });
    },
  );
}
```

---

# `server/src/modules/index.ts`

One import + one entry (rest unchanged):

```ts
import risks from './risks/routes.js';
import smartDiff from './smart-diff/routes.js';
import tickets from './tickets/routes.js';

// …

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

---

# `server/test/tickets-helpers.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { parseTicketKey, rowToResult } from '../src/modules/tickets/helpers.js';
import type { PrTicketRow } from '../src/modules/tickets/repository.js';

/**
 * The property these pin is RESTRAINT. Showing the wrong ticket on a PR is
 * worse than showing none, so the tests that matter are the ones asserting the
 * parser does NOT fire: a version branch, an English word that happens to be
 * followed by a number, a numeric suffix.
 */

describe('parseTicketKey', () => {
  it('finds an upper-case key in a conventional branch', () => {
    expect(parseTicketKey('feat/ENG-482-retry-budget')).toBe('ENG-482');
  });

  it("finds Linear's own lower-case branch format", () => {
    expect(parseTicketKey('marisa/eng-482-retry-budget')).toBe('ENG-482');
  });

  it('matches a bare key and a key at the end of the branch', () => {
    expect(parseTicketKey('ENG-482')).toBe('ENG-482');
    expect(parseTicketKey('chore/ENG-7')).toBe('ENG-7');
  });

  it('prefers an unambiguous UPPER-CASE match over an earlier lower-case one', () => {
    expect(parseTicketKey('fix/step-2-then-ENG-482')).toBe('ENG-482');
  });

  it('returns null for a branch with no reference', () => {
    expect(parseTicketKey('feat/rate-limit-public')).toBeNull();
    expect(parseTicketKey('')).toBeNull();
  });

  it('does NOT read a version as a ticket (letters-only team key)', () => {
    expect(parseTicketKey('release/v2-3-hotfix')).toBeNull();
  });

  it('does NOT match a numeric suffix mid-word', () => {
    expect(parseTicketKey('feat/retrybudget2-x')).toBeNull();
  });

  it('skips known non-ticket words', () => {
    expect(parseTicketKey('fix/add-2-retries')).toBeNull();
    expect(parseTicketKey('chore/bump-utf-8-handling')).toBeNull();
  });

  it('skips zero-padded numbers (Linear does not pad)', () => {
    expect(parseTicketKey('feat/ENG-007-thing')).toBeNull();
  });
});

describe('rowToResult', () => {
  const base: PrTicketRow = {
    prId: 'p1',
    provider: 'linear',
    ticketKey: 'ENG-482',
    branch: 'feat/ENG-482-retry-budget',
    status: 'ok',
    title: 'Retry budget for the public API',
    url: 'https://linear.app/acme/issue/ENG-482',
    stateName: 'In Review',
    stateType: 'started',
    fetchedAt: new Date('2026-08-29T10:00:00.000Z'),
  };

  it('maps an ok row to a ticket and carries the stale flag through', () => {
    const res = rowToResult(base, true);
    expect(res.status).toBe('ok');
    expect(res.ticket?.title).toBe('Retry budget for the public API');
    expect(res.ticket?.state).toEqual({ name: 'In Review', type: 'started' });
    expect(res.reference?.key).toBe('ENG-482');
    expect(res.stale).toBe(true);
  });

  it('maps a negative row to not_found while KEEPING the reference', () => {
    const res = rowToResult(
      { ...base, status: 'not_found', title: null, url: null, stateName: null, stateType: null },
      false,
    );
    expect(res.status).toBe('not_found');
    expect(res.ticket).toBeNull();
    // The branch still names a key — the UI can say which one failed to resolve.
    expect(res.reference?.key).toBe('ENG-482');
  });
});
```

---

# `server/test/tickets.it.test.ts`

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import { MockSecretsProvider, MockTicketClient } from '../src/adapters/mocks.js';
import * as t from '../src/db/schema.js';

/**
 * Ticket route, end to end against a real Postgres.
 *
 * The assertions a unit test cannot make are the workspace guard, the cache
 * actually saving a round trip, and the promise that an unconfigured or broken
 * Linear answers 200 with a reason rather than 500 — the panel's empty state
 * depends on that.
 *
 * EVERY app here injects `secrets` as well as `tickets`. Without it, the
 * "not configured" case falls through to LocalSecretsProvider, which reads
 * `~/.devdigest/secrets.json` and `process.env` — on a dev box with a real
 * LINEAR_API_KEY that turns a hermetic assertion into a live, billed network
 * call, exactly the trap `server/INSIGHTS.md` records for the LLM providers.
 */

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const config = () => loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);

let seq = 0;

async function setupPr(
  db: PgFixture['handle']['db'],
  workspaceId: string,
  branch: string,
): Promise<string> {
  const name = `tickets-${seq}`;
  const [repo] = await db
    .insert(t.repos)
    .values({ workspaceId, owner: 'acme', name, fullName: `acme/${name}` })
    .returning();
  const [pr] = await db
    .insert(t.pullRequests)
    .values({
      workspaceId,
      repoId: repo!.id,
      number: 100 + seq++,
      title: 'Add a retry budget',
      author: 'marisa.koch',
      branch,
      base: 'main',
      headSha: `sha-${seq}`,
      status: 'needs_review',
    })
    .returning();
  return pr!.id;
}

d('Ticket route (Testcontainers pg)', () => {
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

  const build = (tickets?: MockTicketClient) =>
    buildApp({
      config: config(),
      db: pg.handle.db,
      overrides: { secrets: new MockSecretsProvider({}), ...(tickets ? { tickets } : {}) },
    });

  it('resolves the Linear issue named by the branch', async () => {
    const prId = await setupPr(pg.handle.db, workspaceId, 'feat/ENG-482-retry-budget');
    const client = new MockTicketClient();
    const app = await build(client);

    const res = await app.inject({ method: 'GET', url: `/pulls/${prId}/ticket` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.reference).toMatchObject({ provider: 'linear', key: 'ENG-482' });
    expect(body.ticket.title).toBe('Retry budget for the public API');
    expect(body.ticket.state).toEqual({ name: 'In Review', type: 'started' });
    expect(body.stale).toBe(false);
    expect(client.calls).toEqual(['ENG-482']);
    await app.close();
  });

  it('serves the second read from cache, and ?refresh=true bypasses it', async () => {
    const prId = await setupPr(pg.handle.db, workspaceId, 'feat/ENG-482-retry-budget');
    const client = new MockTicketClient();
    const app = await build(client);

    await app.inject({ method: 'GET', url: `/pulls/${prId}/ticket` });
    await app.inject({ method: 'GET', url: `/pulls/${prId}/ticket` });
    // The TTL is real only if the tracker was not asked twice.
    expect(client.calls).toHaveLength(1);

    await app.inject({ method: 'GET', url: `/pulls/${prId}/ticket?refresh=true` });
    expect(client.calls).toHaveLength(2);
    await app.close();
  });

  it('answers no_reference for a branch that names no ticket', async () => {
    const prId = await setupPr(pg.handle.db, workspaceId, 'feat/rate-limit-public');
    const client = new MockTicketClient();
    const app = await build(client);

    const body = (await app.inject({ method: 'GET', url: `/pulls/${prId}/ticket` })).json();
    expect(body.status).toBe('no_reference');
    expect(body.reference).toBeNull();
    expect(body.ticket).toBeNull();
    // No branch reference ⇒ no reason to touch the network at all.
    expect(client.calls).toEqual([]);
    await app.close();
  });

  it('answers not_found (200) for a key Linear does not have', async () => {
    const prId = await setupPr(pg.handle.db, workspaceId, 'feat/ZZZ-991-experiment');
    const app = await build(new MockTicketClient({ tickets: {} }));

    const res = await app.inject({ method: 'GET', url: `/pulls/${prId}/ticket` });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('not_found');
    expect(res.json().reference.key).toBe('ZZZ-991');
    await app.close();
  });

  it('answers not_configured (200) when no LINEAR_API_KEY is set', async () => {
    const prId = await setupPr(pg.handle.db, workspaceId, 'feat/ENG-482-retry-budget');
    // No `tickets` override ⇒ the container resolves the real path and finds no
    // key in the injected (empty) secrets provider.
    const app = await build();

    const res = await app.inject({ method: 'GET', url: `/pulls/${prId}/ticket` });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('not_configured');
    expect(res.json().reference.key).toBe('ENG-482');
    await app.close();
  });

  it('serves the cached ticket marked stale when Linear fails', async () => {
    const prId = await setupPr(pg.handle.db, workspaceId, 'feat/ENG-482-retry-budget');
    const ok = await build(new MockTicketClient());
    await ok.inject({ method: 'GET', url: `/pulls/${prId}/ticket` });
    await ok.close();

    const down = await build(new MockTicketClient({ error: new Error('502 Bad Gateway') }));
    const body = (
      await down.inject({ method: 'GET', url: `/pulls/${prId}/ticket?refresh=true` })
    ).json();
    expect(body.status).toBe('ok');
    expect(body.ticket.title).toBe('Retry budget for the public API');
    expect(body.stale).toBe(true);
    await down.close();
  });

  it('answers unavailable (200) when Linear fails with nothing cached', async () => {
    const prId = await setupPr(pg.handle.db, workspaceId, 'feat/ENG-482-retry-budget');
    const app = await build(new MockTicketClient({ error: new Error('timeout') }));

    const res = await app.inject({ method: 'GET', url: `/pulls/${prId}/ticket` });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('unavailable');
    expect(res.json().ticket).toBeNull();
    await app.close();
  });

  it('404s a PR from another workspace', async () => {
    const [other] = await pg.handle.db
      .insert(t.workspaces)
      .values({ name: 'other' })
      .returning();
    const prId = await setupPr(pg.handle.db, other!.id, 'feat/ENG-482-retry-budget');
    const app = await build(new MockTicketClient());

    const res = await app.inject({ method: 'GET', url: `/pulls/${prId}/ticket` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
```

---

## 6. Follow-ups (not done here)

1. **Client panel** — a `TicketCard` on the PR Overview tab, plus copying
   `contracts/tickets.ts` and the `adapters.ts` addition into
   `client/src/vendor/shared/` byte-identically (the two trees are currently
   identical and kept in sync by hand).
2. **Settings integration** — add `linear` to `ConnTestProvider`,
   `SecretsStatus` and `SECRET_KEY_BY_PROVIDER` so the key can be entered in the
   UI and connection-tested, instead of only via `~/.devdigest/secrets.json` /
   env. Touches `contracts/platform.ts` in both vendored trees.
3. **Ticket context in the reviewer prompt** — feeding the issue title/description
   into `run-executor.ts` needs the untrusted-content wrapper and a decision
   about what it may descope; deliberately not bundled with a display feature.
4. **Jira** — the `TicketClient` port is provider-neutral; a second adapter plus
   a provider selector on the container is the whole change.
