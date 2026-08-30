# Linear ticket context on a pull request — implementation plan + code

**Scope:** `server/` only (plus the additive contract mirror into
`client/src/vendor/shared/`, which is a vendored copy, not client code).
Nothing in `client/src/app`, `client/src/lib` or `e2e/` is touched here — the
UI panel is a follow-up listed at the end.

**How to read this file:** every NEW file is given in full. Three existing files
are large (`vendor/shared/adapters.ts` ~300 lines, `platform/container.ts` 227,
`adapters/mocks.ts` ~250) and the change to each is a surgical addition, so
those are given as *anchored insertions* — the exact existing line to insert
after, then the block to insert. Small existing files are given in full.

---

## 1. What we are building

When a PR's branch name references a Linear issue (`feat/ENG-482-retry-budget`,
or Linear's own lowercase form `sasha/eng-482-retry-budget`), the PR page shows
that issue's **title** and **current status**.

New endpoint:

```
GET /pulls/:id/ticket → PrTicket
```

```jsonc
{
  "state": "ok",
  "ref":   { "key": "ENG-482", "team": "ENG", "number": 482, "source": "branch" },
  "issue": {
    "key": "ENG-482",
    "title": "Add a retry budget to the webhook dispatcher",
    "status": { "name": "In Progress", "type": "started" },
    "url": "https://linear.app/acme/issue/ENG-482/...",
    "assignee": "Marisa Koch",
    "updated_at": "2026-08-27T11:04:00.000Z"
  }
}
```

### The `state` field is the whole design

The endpoint **never fails the PR page**. It answers 200 with a tagged state,
exactly the way `getBlastRadius` returns an empty `BlastResult` carrying a
`DegradedReason` instead of throwing (see
`server/INSIGHTS.md` 2026‑08‑20, "blast no longer has a degraded path"), and the
way `GET /pulls/:id/comments` returns `[]` when GitHub is unreachable
(`server/src/modules/pulls/routes.ts`).

| `state` | Meaning | `ref` | `issue` |
|---|---|---|---|
| `ok` | Issue resolved | set | set |
| `no_reference` | Branch names no ticket | `null` | `null` |
| `not_configured` | No `LINEAR_API_KEY` | set | `null` |
| `not_found` | Linear has no such issue (typo, wrong team, deleted) | set | `null` |
| `unavailable` | Linear errored / timed out | set | `null` |

The only non-200 is **404** when the PR does not exist *in this workspace* —
the standard workspace guard every module repeats (`RisksRepository.prExists`,
`IntentRepository.getPullWithRepo`).

Collapsing these five into `issue: null` would make the panel say "no ticket"
when the truth is "you have not connected Linear yet" — a false claim about the
PR produced by a gap in *configuration*, which is the same failure mode the
`file_rank` inner-join insight warns about.

---

## 2. Layering — where each piece lives and why

Following `.claude/skills/onion-architecture/SKILL.md` and its guides:

| Ring | File | Responsibility |
|---|---|---|
| **Ports** | `server/src/vendor/shared/adapters.ts` | `IssueTracker`, `IssueRef`, `TrackerIssue` — added **before** any adapter exists, per the Rules Checklist |
| **Contracts (DTO)** | `server/src/vendor/shared/contracts/tickets.ts` (+ client mirror) | `PrTicket`, `TicketRef`, `TicketIssue` Zod schemas |
| **Infrastructure** | `server/src/adapters/tickets/linear.ts` | `LinearIssueTracker` — GraphQL over `fetch`, retry/timeout, TTL cache |
| **Composition root** | `server/src/platform/container.ts` | `container.tracker()`; the *only* file importing `LinearIssueTracker` |
| **Domain (pure)** | `server/src/modules/tickets/helpers.ts` + `constants.ts` | branch → `TicketRef` parsing; port→DTO mapping. Zero I/O |
| **Application** | `server/src/modules/tickets/service.ts` | parse → resolve port → tag the state |
| **Data access** | `server/src/modules/tickets/repository.ts` | the only Drizzle access for this domain |
| **Presentation** | `server/src/modules/tickets/routes.ts` | Zod params → one service call → response |
| **Registry** | `server/src/modules/index.ts` | one import + one entry |

### Five decisions worth defending

**(a) The port is `IssueTracker`, not `LinearClient`.** The Dependency Rule says
the inner rings depend on an interface the domain owns, not on a vendor. The
service never learns the word "Linear"; swapping in Jira is a new file under
`adapters/tickets/` plus one line in the container. This is the same shape as
`GitHubClient`/`OctokitGitHubClient`.

**(b) The port addition goes into the *server* copy of `adapters.ts` only.**
`server/src/vendor/shared` and `client/src/vendor/shared` are independent
vendored copies and they have **already** deliberately drifted on this file —
the client's copy has no `commitFiles`, no `findOpenPr`, no `GitClient.sync`,
and its `LLMProvider.id` still lacks `'openrouter'`
(`diff server/src/vendor/shared/adapters.ts client/src/vendor/shared/adapters.ts`).
Adapter *ports* are server-only by nature; the client never implements one. The
new **contract** file, by contrast, *is* mirrored, because the client will parse
`PrTicket`.

**(c) A new module, not a field on `PrDetail`.** `PrDetail` is built by two
different code paths in `pulls/routes.ts` (GitHub-refreshed and offline
fallback) and the `.nullish()`-not-`.nullable()` insight
(`server/INSIGHTS.md` 2026‑06‑24) records how easily that pair drifts. Bolting a
live third-party call onto the PR-detail read also makes the whole PR page wait
on Linear. `risks/routes.ts` states the precedent verbatim: kept separate
"because … the panels that render them fail independently". Same reasoning,
same shape.

**(d) No new table, no migration.** The answer is a pure function of
`pull_requests.branch` plus a live lookup, so — like `RisksService` — it is
recomputed per request rather than cached into a row that goes stale when the
PR is re-imported. Freshness *is* the feature here: a stale "In Progress" is
worse than a slow one. The rate concern is handled by a **process-local TTL
cache inside the adapter**, the same place `PriceBook` puts its TTL cache and
the same place `OctokitGitHubClient` puts its retry/timeout policy. A DB cache
would also mean a drizzle-kit migration, and the migration-prompt trap in
`server/INSIGHTS.md` (2026‑07‑20) is a cost worth not paying for a 200-entry map.

**(e) Native `fetch`, no `@linear/sdk`.** `server/package.json` is
`skip-worktree` (root `CLAUDE.md` + `server/CLAUDE.md`), so adding a dependency
is a deliberately awkward operation. Linear's API is a single POST of a single
GraphQL document — the SDK buys nothing here. Note this is **not** the SSRF
situation `intent/service.ts` refuses ("External URLs are NEVER fetched"): the
host is a compile-time constant, and no user-supplied value ever reaches the URL.

**(f) `container.tracker()` returns `IssueTracker | null`, unlike
`container.github()` which throws `ConfigError`.** Deliberate: the PR page must
distinguish "Linear is not connected" from "Linear is down", and a typed
sentinel expresses that better than catching a `ConfigError` and hoping no other
`ConfigError` reaches the same catch block. Documented at the method.

### Request flow

```
GET /pulls/:id/ticket
  routes.ts        IdParams (uuid) → getContext → service.getForPull
  service.ts       repo.getPullBranch  ──► 404 if not in this workspace
                   parseTicketRef(branch, config.linearTeamKeys)   [pure]
                   ──► no match → { state: 'no_reference' }
                   container.tracker()                             [port]
                   ──► null → { state: 'not_configured' }
                   tracker.getIssue({ team, number })
                   ──► null  → { state: 'not_found' }
                   ──► throw → log.warn → { state: 'unavailable' }
                   ──► issue → { state: 'ok', issue: toTicketIssue(issue) }
```

---

## 3. Branch parsing

Rules, all in `helpers.ts` (pure, unit-tested without a DB):

1. Scan the branch left-to-right for `<KEY>-<NUMBER>` at a segment boundary
   (`^`, `/`, `-`, `_`, `.`), where `KEY` is **2–5 letters** and `NUMBER` is 1–6
   digits not followed by another alphanumeric.
2. **Case-insensitive, normalised to uppercase.** Linear's own "copy git branch
   name" produces `sasha/eng-482-retry-budget` — lowercase. A case-sensitive
   parser silently misses the most common branch shape in a Linear shop.
3. Drop matches whose key is in a small denylist (`UTF`, `SHA`, `RFC`, `ISO`,
   `CVE`, `AES`, `MD`, `HTTP`, `IPV`, …) so `fix/UTF-8-decoding` and
   `chore/CVE-2026-1234` do not masquerade as tickets.
4. If `DEVDIGEST_LINEAR_TEAM_KEYS` is set, only those keys match. This is the
   exact precedent set by `DEVDIGEST_CONTEXT_ROOTS`: process-level, not
   per-workspace, because it describes how *this* installation is laid out.
   Unset → the heuristic above.
5. First surviving match wins; no match → `null` → `state: 'no_reference'`.

A false positive is cheap (one cached `not_found`) but not free, which is why
the denylist and the opt-in allowlist both exist.

---

## 4. Test plan

Placement follows the skill's rule — mocked-ports-only → `*.test.ts`;
real Postgres → `*.it.test.ts` (and `server/CLAUDE.md`'s warning that a
DB-backed test *must* be `*.it.test.ts` or the CI split miscategorises it).

| File | Kind | Covers |
|---|---|---|
| `server/test/tickets-helpers.test.ts` | unit, no DB | uppercase/lowercase keys, `feat/`-prefixed, `_`/`.` separators, denylist rejections, allowlist narrowing, no-match, port→DTO mapping |
| `server/test/tickets-linear.test.ts` | unit, injected `fetch` | GraphQL 200-with-`errors` is an error not a hit; HTTP 500 retries and 401 does not; empty `nodes` → `null`; unknown `state.type` → `'unknown'`; TTL cache serves a second call with **zero** further fetches; TTL expiry re-fetches |
| `server/test/tickets.it.test.ts` | integration (testcontainers) | all five states end-to-end through `app.inject`, plus the cross-workspace 404 and a 422 on a non-uuid id |

Per `server/INSIGHTS.md` 2026‑08‑11, the integration test injects the tracker
port on **every** case (including `tracker: null`) so no path can fall through
to `LocalSecretsProvider` and make a live, billed call.

---

## 5. Follow-ups (deliberately *not* in this change)

- **Client panel.** `client/src/lib/hooks/ticket.ts` + a `TicketCard` in the PR
  Overview, modelled on `hooks/risks.ts`. Needs the mirrored contract from §6.2,
  which is why that file is included here.
- **Settings UI for the key.** `SecretKey` is an open `string & {}` union, so
  `LINEAR_API_KEY` needs no contract change and can be set today in
  `~/.devdigest/secrets.json`. Surfacing it in the API-Keys panel means widening
  `ConnTestProvider` + `SecretsStatus` in `contracts/platform.ts` (both vendored
  copies) and adding a `linear` branch to `/settings/test-connection` — a
  client-visible contract change, so it belongs in its own PR.
- **Feeding the ticket into the review prompt.** `IntentService` already
  assembles PR body / linked issue / spec docs into `AssembledContext`; the
  Linear title+description is a natural fourth source. Out of scope: it changes
  review output and needs its own grounding/source-ledger story.
- **`server/README.md` API map** gains one row for `GET /pulls/:id/ticket`.

---
---

# 6. Code

## 6.1 `server/src/vendor/shared/contracts/tickets.ts` — NEW

```ts
import { z } from 'zod';

/**
 * Issue-tracker context for a pull request (Linear in v1).
 *
 * Deliberately its own contract file rather than fields on `PrDetail`: the
 * lookup is a live third-party call and the panel that renders it must be able
 * to fail on its own, without taking the PR page with it. Same reasoning as
 * `Risks` vs `PrDetail`.
 *
 * Vendor-neutral on purpose — nothing here says "Linear". The tracker is chosen
 * by which adapter the container wires to the `IssueTracker` port.
 */

/**
 * Workflow-state category, normalised across trackers. Mirrors Linear's
 * `WorkflowState.type` values; anything unrecognised degrades to `unknown`
 * rather than being dropped, so a new upstream category still renders.
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
 * The ticket a PR references, and where that reference was found. Present even
 * when the issue itself could not be fetched — "this branch names ENG-482 and
 * we could not reach Linear" is a different, more useful statement than "no
 * ticket".
 */
export const TicketRef = z.object({
  /** Canonical uppercase key, e.g. `ENG-482`. */
  key: z.string(),
  /** Team key, e.g. `ENG`. */
  team: z.string(),
  number: z.number().int(),
  /** Where the reference came from. Only the branch name is parsed in v1. */
  source: z.enum(['branch']),
});
export type TicketRef = z.infer<typeof TicketRef>;

/** The resolved issue, as the PR page renders it. */
export const TicketIssue = z.object({
  key: z.string(),
  title: z.string(),
  status: z.object({ name: z.string(), type: TicketStatusType }),
  url: z.string(),
  assignee: z.string().nullish(),
  updated_at: z.string().nullish(),
});
export type TicketIssue = z.infer<typeof TicketIssue>;

/**
 * Why `issue` is null. The endpoint answers 200 in every one of these cases —
 * only a PR that does not exist in the workspace is an error (404).
 *
 *  ok              → resolved.
 *  no_reference    → the branch names no ticket.
 *  not_configured  → no LINEAR_API_KEY on this install.
 *  not_found       → the tracker has no such issue (typo / wrong team / deleted).
 *  unavailable     → the tracker errored or timed out.
 *
 * Collapsing these to a bare null would let the panel claim "no ticket" when the
 * real answer is "you have not connected Linear yet".
 */
export const PrTicketState = z.enum([
  'ok',
  'no_reference',
  'not_configured',
  'not_found',
  'unavailable',
]);
export type PrTicketState = z.infer<typeof PrTicketState>;

/** GET /pulls/:id/ticket */
export const PrTicket = z.object({
  state: PrTicketState,
  ref: TicketRef.nullable(),
  issue: TicketIssue.nullable(),
});
export type PrTicket = z.infer<typeof PrTicket>;
```

## 6.2 `client/src/vendor/shared/contracts/tickets.ts` — NEW

Byte-identical copy of §6.1. The vendored contracts are committed copies, not a
package dependency (`client/CLAUDE.md`), so the file is duplicated rather than
imported. Included so the follow-up client panel has a schema to parse against.

## 6.3 `server/src/vendor/shared/index.ts` — CHANGED (full contents)

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
 *  - contracts/tickets    PrTicket, TicketRef, TicketIssue (issue-tracker context)
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

## 6.4 `client/src/vendor/shared/index.ts` — CHANGED

Identical to §6.3. (The two `index.ts` copies are currently byte-identical —
`diff` is clean — so keep them that way.)

## 6.5 `server/src/vendor/shared/adapters.ts` — CHANGED (anchored insertion)

Two edits. **Server copy only** — see decision (b) in §2.

**Edit 1 — extend the existing contracts import at the top of the file.**
Replace:

```ts
import type {
  PrMeta,
  PrDetail,
  IssueMeta,
  PrReviewComment,
} from './contracts/platform.js';
```

with:

```ts
import type {
  PrMeta,
  PrDetail,
  IssueMeta,
  PrReviewComment,
} from './contracts/platform.js';
import type { TicketStatusType } from './contracts/tickets.js';
```

**Edit 2 — insert the new port section immediately after the `GitHubClient`
interface's closing brace**, i.e. after this existing line:

```ts
  /** GET /user — for "posting as @user". */
  currentLogin(): Promise<string>;
}
```

and before `// ---------- Git (simple-git, heavy) ----------`. Block to insert:

```ts

// ---------- Issue tracker (Linear in v1) ----------

/** Identifies one issue in a tracker: team key + per-team issue number. */
export interface IssueRef {
  /** Uppercase team key, e.g. `ENG`. */
  team: string;
  /** Per-team issue number, e.g. `482`. */
  number: number;
}

/**
 * A resolved tracker issue. camelCase because this is the PORT type — the
 * snake_case wire DTO (`TicketIssue`) lives in `contracts/tickets.ts` and the
 * tickets module maps between them.
 */
export interface TrackerIssue {
  /** Canonical key, e.g. `ENG-482`. */
  key: string;
  title: string;
  status: { name: string; type: TicketStatusType };
  /** Permalink to the issue in the tracker's own UI. */
  url: string;
  assignee: string | null;
  /** ISO-8601, or null when the tracker does not report it. */
  updatedAt: string | null;
}

/**
 * Issue-tracker port. Deliberately vendor-neutral: the service that consumes it
 * never learns which tracker is behind it, so adding Jira is a new file under
 * `adapters/tickets/` plus one line in the composition root.
 *
 * `getIssue` resolves `null` for "this tracker has no such issue" — a normal,
 * expected answer for a mistyped branch — and THROWS for transport/auth
 * failures. The two are different facts and the PR page renders them
 * differently (`not_found` vs `unavailable`), so an implementation must not
 * flatten one into the other.
 */
export interface IssueTracker {
  readonly id: 'linear';
  getIssue(ref: IssueRef): Promise<TrackerIssue | null>;
}
```

## 6.6 `server/src/adapters/tickets/linear.ts` — NEW

```ts
import type { IssueRef, IssueTracker, TicketStatusType, TrackerIssue } from '@devdigest/shared';
import { withRetry } from '../../platform/resilience.js';

/**
 * IssueTracker over Linear's GraphQL API — thin, dependency-free.
 *
 * WHY NOT `@linear/sdk`: `server/package.json` is `skip-worktree` (see
 * `server/CLAUDE.md`), so adding a dependency is a deliberately awkward
 * operation, and this adapter is one POST of one fixed document. Node ≥22 gives
 * us `fetch` and `AbortSignal.timeout` for free.
 *
 * NOT AN SSRF SURFACE: unlike the external URLs `IntentService` refuses to
 * follow, the endpoint here is a compile-time constant and no user-supplied
 * value ever reaches the URL — only the GraphQL variables, which are a team key
 * matched against `[A-Z]{2,5}` and an integer.
 *
 * The process-local TTL cache lives HERE rather than in the service for the
 * same reason `OctokitGitHubClient` owns its own retry/timeout: how to be a
 * polite client of a specific API is an infrastructure decision, and a future
 * Jira adapter will want a different answer. It is the same pattern as
 * `platform/price-book.ts`. It does NOT dedupe concurrent misses — two
 * simultaneous cold renders cost two requests, which is an acceptable price for
 * a map with no locking.
 */

const ENDPOINT = 'https://api.linear.app/graphql';
const TIMEOUT_MS = 10_000;
/** Long enough that a page refresh is free; short enough that a status change
 *  a reviewer just made in Linear shows up while they are still on the PR. */
const CACHE_TTL_MS = 5 * 60 * 1000;
/** Hard cap so a long-lived process cannot grow the map without bound. */
const CACHE_MAX_ENTRIES = 200;

/**
 * `issue(id:)` wants Linear's internal UUID, which we do not have — we have a
 * human key off a branch name. Filtering by team key + number is the documented
 * way to go from `ENG-482` to an issue, and it is exact (the pair is unique).
 *
 * `$number` is `Float!`, not `Int!`: Linear's `IssueFilter.number` is a
 * `NumberComparator` and its fields are typed `Float`. Sending `Int!` is a
 * schema error, which arrives as HTTP 200 with an `errors` array.
 */
const ISSUE_QUERY = `
  query DevDigestIssue($team: String!, $number: Float!) {
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

/** Linear's own `WorkflowState.type` vocabulary. */
const KNOWN_STATUS_TYPES = new Set([
  'triage',
  'backlog',
  'unstarted',
  'started',
  'completed',
  'canceled',
]);

interface LinearIssueNode {
  identifier?: string | null;
  title?: string | null;
  url?: string | null;
  updatedAt?: string | null;
  state?: { name?: string | null; type?: string | null } | null;
  assignee?: { displayName?: string | null } | null;
}

interface LinearGraphQlBody {
  data?: { issues?: { nodes?: LinearIssueNode[] } | null } | null;
  errors?: { message?: string }[];
}

/**
 * Minimal structural response type. Declared here rather than using the DOM's
 * `Response`: `server/tsconfig.json` sets `lib: ["ES2022"]` with `types:
 * ["node"]`, so there is no DOM lib to borrow from, and this keeps the seam an
 * injectable test double rather than a global.
 */
export interface HttpResponseLike {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<HttpResponseLike>;

/** Carries `status` when the failure was HTTP; omits it for GraphQL-level
 *  errors, which are never worth retrying. */
export class LinearApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'LinearApiError';
  }
}

/**
 * Retry transport hiccups only. A GraphQL error (bad field, unknown team) and a
 * 401/403 (bad key) are deterministic — retrying three times just makes the
 * panel three times slower before showing the same `unavailable`.
 */
function isRetryable(err: unknown): boolean {
  const status = (err as LinearApiError)?.status;
  if (typeof status === 'number') return status === 429 || status >= 500;
  const name = (err as { name?: string })?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

function toStatusType(raw: unknown): TicketStatusType {
  return typeof raw === 'string' && KNOWN_STATUS_TYPES.has(raw)
    ? (raw as TicketStatusType)
    : 'unknown';
}

export interface LinearIssueTrackerOptions {
  /** Injected in tests; defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Injected in tests so TTL expiry is assertable without waiting. */
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
}

export class LinearIssueTracker implements IssueTracker {
  readonly id = 'linear' as const;

  private cache = new Map<string, { at: number; issue: TrackerIssue | null }>();
  private fetchImpl: FetchLike;
  private now: () => number;
  private ttlMs: number;
  private timeoutMs: number;

  /**
   * `apiKey` is a Linear PERSONAL API key, sent as a bare `Authorization`
   * header — Linear's personal keys are NOT bearer tokens and prefixing them
   * with `Bearer ` gets a 401. (OAuth access tokens are the ones that need the
   * prefix; we do not issue those.)
   */
  constructor(
    private readonly apiKey: string,
    opts: LinearIssueTrackerOptions = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.now = opts.now ?? (() => Date.now());
    this.ttlMs = opts.ttlMs ?? CACHE_TTL_MS;
    this.timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  }

  async getIssue(ref: IssueRef): Promise<TrackerIssue | null> {
    const key = `${ref.team.toUpperCase()}-${ref.number}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.issue;

    const issue = await withRetry(() => this.query(ref, key), { retries: 2, isRetryable });
    // Misses are cached too: a branch with a typo'd key would otherwise hit
    // Linear on every render of that PR, forever.
    this.remember(key, issue);
    return issue;
  }

  private async query(ref: IssueRef, key: string): Promise<TrackerIssue | null> {
    const res = await this.fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: this.apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        query: ISSUE_QUERY,
        variables: { team: ref.team.toUpperCase(), number: ref.number },
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      throw new LinearApiError(`Linear API responded ${res.status}`, res.status);
    }

    const raw = await res.text();
    let body: LinearGraphQlBody;
    try {
      body = JSON.parse(raw) as LinearGraphQlBody;
    } catch {
      throw new LinearApiError('Linear API returned a non-JSON body');
    }

    // GraphQL reports its own failures with HTTP 200 + an `errors` array. Not
    // checking this is how a schema/auth error becomes a silent "no ticket".
    if (body.errors?.length) {
      const detail = body.errors.map((e) => e.message ?? 'unknown error').join('; ');
      throw new LinearApiError(`Linear API error: ${detail}`);
    }

    const node = body.data?.issues?.nodes?.[0];
    if (!node) return null;

    return {
      key: node.identifier ?? key,
      title: node.title ?? key,
      status: {
        name: node.state?.name ?? 'Unknown',
        type: toStatusType(node.state?.type),
      },
      url: node.url ?? '',
      assignee: node.assignee?.displayName ?? null,
      updatedAt: node.updatedAt ?? null,
    };
  }

  /** FIFO eviction — insertion order is Map's own iteration order. */
  private remember(key: string, issue: TrackerIssue | null): void {
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(key, { at: this.now(), issue });
  }
}
```

## 6.7 `server/src/platform/container.ts` — CHANGED (anchored insertions)

Four small edits. `LinearIssueTracker` is imported **here and nowhere else** —
that is the composition-root rule.

**Edit 1 — the port type import.** Replace:

```ts
import type {
  AuthProvider,
  SecretsProvider,
  GitHubClient,
  GitClient,
  CodeIndex,
  Embedder,
  LLMProvider,
} from '@devdigest/shared';
```

with:

```ts
import type {
  AuthProvider,
  SecretsProvider,
  GitHubClient,
  GitClient,
  CodeIndex,
  Embedder,
  IssueTracker,
  LLMProvider,
} from '@devdigest/shared';
```

**Edit 2 — the concrete adapter import.** Insert after the existing line:

```ts
import { RipgrepCodeIndex } from '../adapters/codeindex/ripgrep.js';
```

this line:

```ts
import { LinearIssueTracker } from '../adapters/tickets/linear.js';
```

**Edit 3 — the override slot.** In `ContainerOverrides`, insert after:

```ts
  embedder?: Embedder;
```

this block:

```ts
  /**
   * Issue-tracker port. `null` is MEANINGFUL and distinct from omitting the
   * key: it pins the container to "no tracker configured" so a test can assert
   * the `not_configured` state without a secrets file on the box.
   */
  tracker?: IssueTracker | null;
```

**Edit 4 — the lazy field, the resolver, and cache invalidation.** Insert after
the existing private field:

```ts
  private _embedder?: Embedder;
```

this field:

```ts
  /**
   * Three states, not two: `undefined` = not resolved yet, `null` = resolved
   * and there is no key. Without the distinction an unconfigured install
   * re-reads the secrets file on every PR render.
   */
  private _tracker?: IssueTracker | null;
```

Then insert the resolver immediately after the `async github()` method's closing
brace (before `/** Resolve an LLM provider by id; … */`):

```ts

  /**
   * Issue tracker (Linear), or `null` when no `LINEAR_API_KEY` is configured.
   *
   * DELIBERATE DEVIATION from `github()`, which throws `ConfigError` when its
   * secret is missing: the PR page has to tell "Linear is not connected" apart
   * from "Linear is down", and a typed `null` says that far more precisely than
   * an exception the caller has to identify by class and hope nothing else in
   * the call stack throws the same one.
   *
   * The key is a Linear PERSONAL API key; set it in `~/.devdigest/secrets.json`
   * (there is no Settings UI for it yet — see the tickets module docblock).
   */
  async tracker(): Promise<IssueTracker | null> {
    if (this.overrides.tracker !== undefined) return this.overrides.tracker;
    if (this._tracker !== undefined) return this._tracker;
    const key = await this.secrets.get('LINEAR_API_KEY');
    this._tracker = key ? new LinearIssueTracker(key) : null;
    return this._tracker;
  }
```

Finally, in `invalidateSecretCaches()`, insert after `this._github = undefined;`:

```ts
    this._tracker = undefined;
```

## 6.8 `server/src/platform/config.ts` — CHANGED (anchored insertions)

**Edit 1 — the env var.** Insert into `EnvSchema` after the
`DEVDIGEST_CONTEXT_ROOTS` entry:

```ts
  // Comma-separated Linear team keys (e.g. `ENG,DES`). Unset → the branch
  // parser falls back to a heuristic. Narrowing to real teams is what makes a
  // branch like `fix/ipv6-1234` unambiguously NOT a ticket.
  DEVDIGEST_LINEAR_TEAM_KEYS: z.string().optional(),
```

**Edit 2 — the `AppConfig` field.** Insert after `contextRoots: string[];`:

```ts
  /**
   * Linear team keys this installation actually uses, uppercased, or `null` to
   * let the branch parser guess.
   *
   * PROCESS-LEVEL, following the `DEVDIGEST_CONTEXT_ROOTS` precedent: the team
   * keys describe the org this deployment reviews for, the same way the clone
   * directory describes where it puts checkouts. A per-workspace override would
   * need a settings row, a migration and a UI to express a value that is
   * identical for every workspace on a local-first tool.
   */
  linearTeamKeys: string[] | null;
```

**Edit 3 — the parser.** Insert after `parseContextRoots`:

```ts
/** A Linear team key is 2–5 letters (`ENG`, `DES`, `CORE`). Anything else in
    the env is a typo and is dropped rather than matched against. */
const TEAM_KEY_RE = /^[A-Za-z]{2,5}$/;

function parseTeamKeys(raw: string | undefined): string[] | null {
  if (!raw) return null;
  const keys = raw
    .split(',')
    .map((k) => k.trim().toUpperCase())
    .filter((k) => TEAM_KEY_RE.test(k));
  // Every entry filtered out = a misconfiguration. Fall back to the heuristic
  // rather than to an empty allowlist, which would match nothing at all.
  return keys.length > 0 ? [...new Set(keys)] : null;
}
```

**Edit 4 — the returned config.** Insert after
`contextRoots: parseContextRoots(parsed.DEVDIGEST_CONTEXT_ROOTS),`:

```ts
    linearTeamKeys: parseTeamKeys(parsed.DEVDIGEST_LINEAR_TEAM_KEYS),
```

## 6.9 `server/src/modules/tickets/constants.ts` — NEW

```ts
/**
 * Branch-parsing rules for the tickets module. NO model is involved: the ticket
 * reference is something the branch name literally contains, which is why the
 * response always echoes back the `ref` it parsed.
 */

/**
 * `<KEY>-<NUMBER>` at a segment boundary.
 *
 *  - The leading `(?:^|[/_.\-])` anchors to a real boundary so `xENG-482` and
 *    the `8` in `utf8-...` cannot start a match.
 *  - The key is 2–5 LETTERS only. Linear allows digits in a team key, but
 *    admitting them costs far more than it buys: `v2-3`, `ipv6-1`, `es6-42` all
 *    become tickets. Letters-only covers every team key we have seen and is the
 *    single most effective false-positive filter here.
 *  - Case-INSENSITIVE, because Linear's own "copy git branch name" produces a
 *    lowercase key (`sasha/eng-482-retry-budget`). A case-sensitive parser
 *    misses the most common branch shape in a Linear shop. Matches are
 *    normalised to uppercase.
 *  - The trailing `(?![A-Za-z0-9])` keeps `ENG-4821` from parsing as `ENG-482`,
 *    while still allowing `ENG-482-retry-budget`.
 */
export const TICKET_REF_RE = /(?:^|[/_.\-])([A-Za-z]{2,5})-(\d{1,6})(?![A-Za-z0-9])/g;

/**
 * Tokens that fit the pattern but are never team keys. Every one of these has a
 * plausible branch: `fix/UTF-8-decoding`, `chore/CVE-2026-1234`,
 * `feat/RFC-7231-conditional-requests`, `fix/SHA-256-rotation`.
 *
 * This list is a heuristic and does not need to be exhaustive — a false
 * positive costs one cached `not_found`, not a wrong claim about the code. Set
 * `DEVDIGEST_LINEAR_TEAM_KEYS` to make matching exact instead.
 */
export const NON_TEAM_TOKENS = new Set([
  'AES',
  'API',
  'CVE',
  'ES',
  'HTTP',
  'IPV',
  'ISO',
  'JSON',
  'MD',
  'PR',
  'RFC',
  'RGB',
  'RSA',
  'SHA',
  'SSL',
  'TLS',
  'UTF',
  'UTC',
  'V',
  'WCAG',
  'X',
]);
```

## 6.10 `server/src/modules/tickets/helpers.ts` — NEW

```ts
import type { TicketIssue, TicketRef, TrackerIssue } from '@devdigest/shared';
import { NON_TEAM_TOKENS, TICKET_REF_RE } from './constants.js';

/**
 * Pure helpers for the tickets module — no I/O, no container, no DB. Every
 * decision the module makes that is NOT a network call lives here, so the
 * interesting cases are covered by a unit test that needs neither Docker nor a
 * Linear key.
 */

/**
 * The ticket a branch name references, or `null`.
 *
 * @param branch        e.g. `feat/ENG-482-retry-budget` or `sasha/eng-482-retry`
 * @param allowedTeams  `AppConfig.linearTeamKeys` — uppercase team keys this
 *                      install actually uses, or `null` to use the heuristic.
 *
 * First surviving match wins. Returning `null` is a normal answer, not a
 * failure: most branches on most repos name no ticket at all.
 */
export function parseTicketRef(branch: string, allowedTeams: string[] | null): TicketRef | null {
  // A /g regex carries lastIndex across calls; build a fresh one per call so the
  // function stays pure and re-entrant.
  const re = new RegExp(TICKET_REF_RE.source, TICKET_REF_RE.flags);
  const allow = allowedTeams ? new Set(allowedTeams.map((k) => k.toUpperCase())) : null;

  for (let m = re.exec(branch); m !== null; m = re.exec(branch)) {
    const team = m[1]!.toUpperCase();
    const number = Number(m[2]!);
    if (!Number.isSafeInteger(number) || number <= 0) continue;
    // An explicit allowlist replaces the heuristic entirely — if the operator
    // told us the team keys, a denylist guess can only make the answer worse.
    if (allow) {
      if (!allow.has(team)) continue;
    } else if (NON_TEAM_TOKENS.has(team)) {
      continue;
    }
    return { key: `${team}-${number}`, team, number, source: 'branch' };
  }
  return null;
}

/**
 * Port type → wire DTO. The port is camelCase (it is an internal boundary); the
 * contract is snake_case (it is the HTTP surface every other endpoint speaks).
 * Doing the rename here — rather than making the adapter emit snake_case — is
 * what keeps a second tracker adapter from having to know about our HTTP shape.
 */
export function toTicketIssue(issue: TrackerIssue): TicketIssue {
  return {
    key: issue.key,
    title: issue.title,
    status: { name: issue.status.name, type: issue.status.type },
    url: issue.url,
    assignee: issue.assignee,
    updated_at: issue.updatedAt,
  };
}
```

## 6.11 `server/src/modules/tickets/repository.ts` — NEW

```ts
import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';

/**
 * Tickets data-access — `pull_requests` only, and only the two columns this
 * module reads. The ONLY layer touching the DB for this domain.
 *
 * The workspace-scoped PR guard is repeated here rather than imported from
 * another module's repository, per the house rule that a module never reaches
 * into another module's folder (same as `RisksRepository.prExists` and
 * `IntentRepository.getPullWithRepo`). A plain workspace-scoped row read is not
 * another module's business logic.
 */
export class TicketsRepository {
  constructor(private db: Db) {}

  /**
   * The PR's branch name, or `undefined` when the PR does not exist IN THIS
   * WORKSPACE — the route turns that into a 404, never a cross-tenant read.
   */
  async getBranch(workspaceId: string, prId: string): Promise<string | undefined> {
    const [row] = await this.db
      .select({ branch: t.pullRequests.branch })
      .from(t.pullRequests)
      .where(and(eq(t.pullRequests.workspaceId, workspaceId), eq(t.pullRequests.id, prId)));
    return row?.branch;
  }
}
```

## 6.12 `server/src/modules/tickets/service.ts` — NEW

```ts
import type { PrTicket } from '@devdigest/shared';
import type { Container } from '../../platform/container.js';
import { NotFoundError } from '../../platform/errors.js';
import { TicketsRepository } from './repository.js';
import { parseTicketRef, toTicketIssue } from './helpers.js';

/**
 * Issue-tracker context for one PR: the ticket its branch names, and that
 * ticket's current title + status.
 *
 * No model, no cost, no persistence. The answer is a pure function of
 * `pull_requests.branch` plus one live tracker lookup, so it is recomputed per
 * request rather than cached into a row that goes stale the moment somebody
 * moves the issue in Linear — freshness IS the feature. Rate is handled inside
 * the adapter's TTL cache, where a per-tracker policy belongs.
 *
 * DEGRADES, NEVER FAILS. Every outcome other than "this PR is not in your
 * workspace" is a 200 carrying a `state` that names the reason. A panel that
 * says "no ticket" when the truth is "Linear is not connected" is a false claim
 * about the PR produced by a gap in configuration — the same failure mode the
 * blast-radius `file_rank` regression produced about the code.
 *
 * SETUP: put a Linear personal API key in `~/.devdigest/secrets.json` as
 * `LINEAR_API_KEY`. There is no Settings UI for it yet (that needs a
 * client-visible change to `ConnTestProvider`); until then an install without
 * the key answers `not_configured` rather than erroring.
 */

/** Minimal structured-log sink, satisfied by Fastify's `req.log.warn`. */
export type TicketLogger = (obj: Record<string, unknown>, msg: string) => void;

export class TicketsService {
  private repo: TicketsRepository;

  constructor(private container: Container) {
    this.repo = new TicketsRepository(container.db);
  }

  async getForPull(workspaceId: string, prId: string, log: TicketLogger): Promise<PrTicket> {
    const branch = await this.repo.getBranch(workspaceId, prId);
    if (branch === undefined) throw new NotFoundError('Pull request not found');

    const ref = parseTicketRef(branch, this.container.config.linearTeamKeys);
    if (!ref) return { state: 'no_reference', ref: null, issue: null };

    const tracker = await this.container.tracker();
    if (!tracker) return { state: 'not_configured', ref, issue: null };

    try {
      const issue = await tracker.getIssue({ team: ref.team, number: ref.number });
      // `null` is the tracker saying "no such issue" — a mistyped or renamed
      // key. Distinct from the throw below, and rendered differently.
      if (!issue) return { state: 'not_found', ref, issue: null };
      return { state: 'ok', ref, issue: toTicketIssue(issue) };
    } catch (err) {
      // Logged, not rethrown: an unreachable tracker must not take the PR page
      // down with it. Same posture as `GET /pulls/:id/comments` when GitHub is
      // offline.
      log(
        { err: err instanceof Error ? err.message : String(err), ticket: ref.key },
        'issue-tracker lookup failed; serving degraded ticket context',
      );
      return { state: 'unavailable', ref, issue: null };
    }
  }
}
```

## 6.13 `server/src/modules/tickets/routes.ts` — NEW

```ts
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { PrTicket } from '@devdigest/shared';
import { getContext } from '../_shared/context.js';
import { IdParams } from '../_shared/schemas.js';
import { TicketsService } from './service.js';

/**
 * Tickets module.
 *   GET /pulls/:id/ticket → the Linear issue this PR's branch references,
 *                           with its current title and status
 *
 * Kept separate from `GET /pulls/:id` even though both describe the same PR:
 * this one makes a live third-party call, and folding it into PR detail would
 * make the whole page wait on Linear. Same reasoning that keeps `/risks` and
 * `/blast` apart — the panels fail independently.
 */
export default async function ticketsRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const service = new TicketsService(app.container);

  app.get('/pulls/:id/ticket', { schema: { params: IdParams } }, async (req): Promise<PrTicket> => {
    const { workspaceId } = await getContext(app.container, req);
    return service.getForPull(workspaceId, req.params.id, (obj, msg) => req.log.warn(obj, msg));
  });
}
```

## 6.14 `server/src/modules/index.ts` — CHANGED (full contents)

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

## 6.15 `server/src/adapters/mocks.ts` — CHANGED (anchored insertion)

**Edit 1 — the type import.** Add `IssueTracker`, `IssueRef` and `TrackerIssue`
to the existing `import type { … } from '@devdigest/shared';` block (alongside
`GitHubClient`, `GitClient`, …).

**Edit 2 — the mock.** Append at the end of the file, after
`MockSecretsProvider`'s closing brace:

```ts

// ---------- Mock IssueTracker ----------
/**
 * Deterministic issue tracker for tests. Seeded by canonical key (`ENG-482`);
 * anything unseeded resolves to `null`, which is the tracker's honest "no such
 * issue" — NOT an error. Set `failWith` to exercise the `unavailable` path.
 *
 * `calls` mirrors `MockLLMProvider.calls` so a test can assert an endpoint made
 * NO tracker call (e.g. a branch that names no ticket must never reach the
 * network).
 */
export class MockIssueTracker implements IssueTracker {
  readonly id = 'linear' as const;
  public calls: IssueRef[] = [];

  constructor(
    private issues: Record<string, TrackerIssue> = {},
    private failWith?: Error,
  ) {}

  async getIssue(ref: IssueRef): Promise<TrackerIssue | null> {
    this.calls.push(ref);
    if (this.failWith) throw this.failWith;
    return this.issues[`${ref.team.toUpperCase()}-${ref.number}`] ?? null;
  }
}
```

## 6.16 `server/test/tickets-helpers.test.ts` — NEW

```ts
import { describe, it, expect } from 'vitest';
import { parseTicketRef, toTicketIssue } from '../src/modules/tickets/helpers.js';

/**
 * Branch parsing is the one place this feature can be confidently wrong: it
 * either invents a ticket the branch does not name, or misses the lowercase
 * form Linear's own "copy git branch name" produces. Both are covered here, no
 * DB and no key required.
 */
describe('parseTicketRef', () => {
  it('parses the canonical uppercase form', () => {
    expect(parseTicketRef('feat/ENG-482-retry-budget', null)).toEqual({
      key: 'ENG-482',
      team: 'ENG',
      number: 482,
      source: 'branch',
    });
  });

  it("parses Linear's own lowercase branch name and normalises the key", () => {
    // `Copy git branch name` in Linear yields exactly this shape.
    expect(parseTicketRef('sasha/eng-482-retry-budget', null)?.key).toBe('ENG-482');
  });

  it('matches at the start of the branch and after _ and .', () => {
    expect(parseTicketRef('ENG-1', null)?.key).toBe('ENG-1');
    expect(parseTicketRef('wip_des-77_spacing', null)?.key).toBe('DES-77');
    expect(parseTicketRef('release.ops-9.hotfix', null)?.key).toBe('OPS-9');
  });

  it('returns null when the branch names no ticket', () => {
    expect(parseTicketRef('chore/bump-deps', null)).toBeNull();
    expect(parseTicketRef('main', null)).toBeNull();
  });

  it('does not treat a longer number as a shorter one', () => {
    expect(parseTicketRef('feat/ENG-4821', null)?.number).toBe(4821);
  });

  it('rejects well-known non-team tokens', () => {
    expect(parseTicketRef('fix/UTF-8-decoding', null)).toBeNull();
    expect(parseTicketRef('chore/CVE-2026-1234', null)).toBeNull();
    expect(parseTicketRef('feat/RFC-7231-conditional-requests', null)).toBeNull();
  });

  it('rejects keys containing digits (v2-3, ipv6-1) via the letters-only rule', () => {
    expect(parseTicketRef('feat/v2-3-migration', null)).toBeNull();
    expect(parseTicketRef('fix/ipv6-1-parsing', null)).toBeNull();
  });

  it('an allowlist replaces the heuristic entirely', () => {
    expect(parseTicketRef('feat/ENG-482-x', ['DES'])).toBeNull();
    expect(parseTicketRef('feat/ENG-482-x', ['eng', 'des'])?.team).toBe('ENG');
    // A token the denylist would drop is accepted when the operator says it is
    // a real team key.
    expect(parseTicketRef('fix/api-12-timeout', ['API'])?.key).toBe('API-12');
  });

  it('takes the first surviving match when a branch has several', () => {
    expect(parseTicketRef('fix/UTF-8-then-ENG-9-really', null)?.key).toBe('ENG-9');
  });

  it('is re-entrant — the /g regex does not carry lastIndex between calls', () => {
    const branch = 'feat/ENG-482-retry';
    expect(parseTicketRef(branch, null)).toEqual(parseTicketRef(branch, null));
  });
});

describe('toTicketIssue', () => {
  it('renames the port type to the snake_case wire DTO', () => {
    expect(
      toTicketIssue({
        key: 'ENG-482',
        title: 'Add a retry budget',
        status: { name: 'In Progress', type: 'started' },
        url: 'https://linear.app/acme/issue/ENG-482',
        assignee: 'Marisa Koch',
        updatedAt: '2026-08-27T11:04:00.000Z',
      }),
    ).toEqual({
      key: 'ENG-482',
      title: 'Add a retry budget',
      status: { name: 'In Progress', type: 'started' },
      url: 'https://linear.app/acme/issue/ENG-482',
      assignee: 'Marisa Koch',
      updated_at: '2026-08-27T11:04:00.000Z',
    });
  });
});
```

## 6.17 `server/test/tickets-linear.test.ts` — NEW

```ts
import { describe, it, expect } from 'vitest';
import {
  LinearIssueTracker,
  type FetchLike,
  type HttpResponseLike,
} from '../src/adapters/tickets/linear.js';

/**
 * Adapter unit tests — `fetch` and the clock are injected, so this suite is
 * hermetic and key-free (TESTING.md: "Mock the outside world").
 *
 * The case worth having is the GraphQL one: Linear reports a bad query or a bad
 * key with HTTP 200 plus an `errors` array. An adapter that only checks
 * `res.ok` turns an auth failure into a silent "this PR has no ticket".
 */

function jsonResponse(body: unknown, status = 200): HttpResponseLike {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

const NODE = {
  identifier: 'ENG-482',
  title: 'Add a retry budget to the webhook dispatcher',
  url: 'https://linear.app/acme/issue/ENG-482/retry-budget',
  updatedAt: '2026-08-27T11:04:00.000Z',
  state: { name: 'In Progress', type: 'started' },
  assignee: { displayName: 'Marisa Koch' },
};

function trackerWith(fetchImpl: FetchLike, now: () => number = () => 0) {
  return new LinearIssueTracker('lin_api_test', { fetchImpl, now, ttlMs: 1000 });
}

describe('LinearIssueTracker', () => {
  it('maps a hit onto the port type', async () => {
    const tracker = trackerWith(async () => jsonResponse({ data: { issues: { nodes: [NODE] } } }));
    expect(await tracker.getIssue({ team: 'ENG', number: 482 })).toEqual({
      key: 'ENG-482',
      title: 'Add a retry budget to the webhook dispatcher',
      status: { name: 'In Progress', type: 'started' },
      url: 'https://linear.app/acme/issue/ENG-482/retry-budget',
      assignee: 'Marisa Koch',
      updatedAt: '2026-08-27T11:04:00.000Z',
    });
  });

  it('sends the team key and number as GraphQL variables, key uppercased', async () => {
    let sent: unknown;
    const tracker = trackerWith(async (_url, init) => {
      sent = JSON.parse(init.body);
      return jsonResponse({ data: { issues: { nodes: [NODE] } } });
    });
    await tracker.getIssue({ team: 'eng', number: 482 });
    expect((sent as { variables: unknown }).variables).toEqual({ team: 'ENG', number: 482 });
  });

  it('sends the personal API key as a BARE Authorization header (no Bearer)', async () => {
    let auth: string | undefined;
    const tracker = trackerWith(async (_url, init) => {
      auth = init.headers.authorization;
      return jsonResponse({ data: { issues: { nodes: [] } } });
    });
    await tracker.getIssue({ team: 'ENG', number: 1 });
    expect(auth).toBe('lin_api_test');
  });

  it('resolves null (not an error) when the issue does not exist', async () => {
    const tracker = trackerWith(async () => jsonResponse({ data: { issues: { nodes: [] } } }));
    expect(await tracker.getIssue({ team: 'ENG', number: 999 })).toBeNull();
  });

  it('THROWS on a GraphQL error even though the HTTP status is 200', async () => {
    const tracker = trackerWith(async () =>
      jsonResponse({ errors: [{ message: 'Authentication required' }] }),
    );
    await expect(tracker.getIssue({ team: 'ENG', number: 482 })).rejects.toThrow(
      /Authentication required/,
    );
  });

  it('degrades an unrecognised workflow-state type to "unknown"', async () => {
    const tracker = trackerWith(async () =>
      jsonResponse({
        data: { issues: { nodes: [{ ...NODE, state: { name: 'Paused', type: 'hibernating' } }] } },
      }),
    );
    const issue = await tracker.getIssue({ team: 'ENG', number: 482 });
    expect(issue?.status).toEqual({ name: 'Paused', type: 'unknown' });
  });

  it('does not retry a 401', async () => {
    let calls = 0;
    const tracker = trackerWith(async () => {
      calls++;
      return jsonResponse({ message: 'nope' }, 401);
    });
    await expect(tracker.getIssue({ team: 'ENG', number: 482 })).rejects.toThrow(/401/);
    expect(calls).toBe(1);
  });

  it('retries a 500 and succeeds', async () => {
    let calls = 0;
    const tracker = trackerWith(async () => {
      calls++;
      return calls === 1
        ? jsonResponse({ message: 'boom' }, 500)
        : jsonResponse({ data: { issues: { nodes: [NODE] } } });
    });
    expect((await tracker.getIssue({ team: 'ENG', number: 482 }))?.key).toBe('ENG-482');
    expect(calls).toBe(2);
  });

  it('serves a repeat lookup from the TTL cache without a second fetch', async () => {
    let calls = 0;
    const tracker = trackerWith(async () => {
      calls++;
      return jsonResponse({ data: { issues: { nodes: [NODE] } } });
    });
    await tracker.getIssue({ team: 'ENG', number: 482 });
    await tracker.getIssue({ team: 'eng', number: 482 });
    expect(calls).toBe(1);
  });

  it('caches misses too, so a typo’d key cannot hammer the API', async () => {
    let calls = 0;
    const tracker = trackerWith(async () => {
      calls++;
      return jsonResponse({ data: { issues: { nodes: [] } } });
    });
    await tracker.getIssue({ team: 'ENG', number: 999 });
    await tracker.getIssue({ team: 'ENG', number: 999 });
    expect(calls).toBe(1);
  });

  it('re-fetches once the TTL expires', async () => {
    let calls = 0;
    let clock = 0;
    const tracker = new LinearIssueTracker('k', {
      fetchImpl: async () => {
        calls++;
        return jsonResponse({ data: { issues: { nodes: [NODE] } } });
      },
      now: () => clock,
      ttlMs: 1000,
    });
    await tracker.getIssue({ team: 'ENG', number: 482 });
    clock = 1001;
    await tracker.getIssue({ team: 'ENG', number: 482 });
    expect(calls).toBe(2);
  });
});
```

## 6.18 `server/test/tickets.it.test.ts` — NEW

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import { MockIssueTracker } from '../src/adapters/mocks.js';
import type { ContainerOverrides } from '../src/platform/container.js';
import type { TrackerIssue } from '@devdigest/shared';
import * as t from '../src/db/schema.js';

/**
 * GET /pulls/:id/ticket end to end against a real Postgres.
 *
 * The assertions a unit test cannot make: the workspace guard, and the promise
 * that EVERY tracker outcome is a 200 with a `state` the panel can render —
 * never a 500 that takes the PR page down.
 *
 * Every case injects the tracker port explicitly, `tracker: null` included. Per
 * `server/INSIGHTS.md` (2026-08-11), a path that resolves a provider without an
 * injected override silently falls through to `LocalSecretsProvider` and can
 * make a live call off the developer's own key.
 */

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const config = () => loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);

const ENG_482: TrackerIssue = {
  key: 'ENG-482',
  title: 'Add a retry budget to the webhook dispatcher',
  status: { name: 'In Progress', type: 'started' },
  url: 'https://linear.app/acme/issue/ENG-482/retry-budget',
  assignee: 'Marisa Koch',
  updatedAt: '2026-08-27T11:04:00.000Z',
};

let seq = 0;

d('Tickets route (Testcontainers pg)', () => {
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

  function appWith(overrides: ContainerOverrides) {
    return buildApp({ config: config(), db: pg.handle.db, overrides });
  }

  /** A repo + one PR on `branch`, in `wsId` (defaults to the seeded workspace). */
  async function setupPr(branch: string, wsId = workspaceId) {
    const db = pg.handle.db;
    const name = `tickets-${seq++}`;
    const [repo] = await db
      .insert(t.repos)
      .values({ workspaceId: wsId, owner: 'acme', name, fullName: `acme/${name}` })
      .returning();
    const [pr] = await db
      .insert(t.pullRequests)
      .values({
        workspaceId: wsId,
        repoId: repo!.id,
        number: 1,
        title: 'Retry budget',
        author: 'marisa.koch',
        branch,
        base: 'main',
        headSha: `sha-${seq}`,
        status: 'needs_review',
      })
      .returning();
    return pr!;
  }

  it('resolves the issue for a branch naming a ticket', async () => {
    const pr = await setupPr('feat/ENG-482-retry-budget');
    const tracker = new MockIssueTracker({ 'ENG-482': ENG_482 });
    const app = await appWith({ tracker });
    const res = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/ticket` });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.state).toBe('ok');
    expect(body.ref).toEqual({ key: 'ENG-482', team: 'ENG', number: 482, source: 'branch' });
    expect(body.issue.title).toBe('Add a retry budget to the webhook dispatcher');
    expect(body.issue.status).toEqual({ name: 'In Progress', type: 'started' });
    expect(tracker.calls).toEqual([{ team: 'ENG', number: 482 }]);
    await app.close();
  });

  it("handles Linear's own lowercase branch name", async () => {
    const pr = await setupPr('sasha/eng-482-retry-budget');
    const app = await appWith({ tracker: new MockIssueTracker({ 'ENG-482': ENG_482 }) });
    const res = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/ticket` });
    expect(res.json().issue.key).toBe('ENG-482');
    await app.close();
  });

  it('reports no_reference WITHOUT calling the tracker', async () => {
    const pr = await setupPr('chore/bump-deps');
    const tracker = new MockIssueTracker({ 'ENG-482': ENG_482 });
    const app = await appWith({ tracker });
    const res = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/ticket` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ state: 'no_reference', ref: null, issue: null });
    // A branch that names no ticket must never reach the network.
    expect(tracker.calls).toEqual([]);
    await app.close();
  });

  it('reports not_configured (with the ref) when no tracker is wired', async () => {
    const pr = await setupPr('feat/ENG-482-retry-budget');
    const app = await appWith({ tracker: null });
    const res = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/ticket` });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.state).toBe('not_configured');
    // The ref survives: "this branch names ENG-482, connect Linear to see it".
    expect(body.ref.key).toBe('ENG-482');
    expect(body.issue).toBeNull();
    await app.close();
  });

  it('reports not_found when the tracker has no such issue', async () => {
    const pr = await setupPr('feat/ENG-777-ghost');
    const app = await appWith({ tracker: new MockIssueTracker({}) });
    const res = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/ticket` });

    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe('not_found');
    await app.close();
  });

  it('reports unavailable — a 200, not a 500 — when the tracker throws', async () => {
    const pr = await setupPr('feat/ENG-482-retry-budget');
    const app = await appWith({
      tracker: new MockIssueTracker({}, new Error('Linear API responded 503')),
    });
    const res = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/ticket` });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.state).toBe('unavailable');
    expect(body.ref.key).toBe('ENG-482');
    await app.close();
  });

  it('404s a PR belonging to another workspace', async () => {
    const [other] = await pg.handle.db
      .insert(t.workspaces)
      .values({ name: `other-${seq++}` })
      .returning();
    const pr = await setupPr('feat/ENG-482-retry-budget', other!.id);
    const app = await appWith({ tracker: new MockIssueTracker({ 'ENG-482': ENG_482 }) });
    const res = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/ticket` });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
    await app.close();
  });

  it('422s a non-uuid id at the edge', async () => {
    const app = await appWith({ tracker: null });
    const res = await app.inject({ method: 'GET', url: '/pulls/not-a-uuid/ticket' });
    expect(res.statusCode).toBe(422);
    await app.close();
  });
});
```

---

## 7. Verification

```bash
cd server
pnpm typecheck
pnpm exec vitest run --exclude '**/*.it.test.ts'   # unit lane (no Docker)
pnpm exec vitest run .it.test                      # integration lane (Docker)
cd ../client && pnpm typecheck                     # the mirrored contract compiles
```

Per `server/INSIGHTS.md` (2026‑08‑28), `pnpm typecheck` only sees `src/**` —
`server/test/**` is outside the tsconfig `include`, so the unit lane above is
the real gate on the test files, not `tsc`.

No migration to run: this change adds no table and no column.

Manual smoke, since a green suite has twice failed to catch what a real call
found (`server/INSIGHTS.md` 2026‑08‑20):

```bash
printf '{"LINEAR_API_KEY":"lin_api_..."}' > ~/.devdigest/secrets.json  # merge, don't clobber
curl -s localhost:3001/pulls/<pr-uuid>/ticket | jq
```
