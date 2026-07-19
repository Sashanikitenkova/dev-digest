# INSIGHTS — server

Non-obvious decisions, gotchas, and "why is this built this way" for `server`.
Read before changing a long-standing convention, or when something behaves
surprisingly that the code alone doesn't explain.

Captured via the `engineering-insights` skill — see
[`.claude/skills/engineering-insights/SKILL.md`](../.claude/skills/engineering-insights/SKILL.md)
for entry format and the append-only rule. Sections are fixed; don't add,
remove, or rename them. Code under `src/modules/repo-intel/**` belongs
here too — it's a module inside `server`, not its own package.

## What Works

_Nothing recorded yet._

## What Doesn't Work

_Nothing recorded yet._

## Codebase Patterns

### 2026-06-24 — [Decision] "Latest review round" needs a shared `ranAt`, not each row's own `defaultNow()`

`agentRuns.ranAt` defaults independently per row (`pgTable` `.defaultNow()`), so N agents queued by one "Run Review" click used to land at N slightly different timestamps with no shared identifier. To let a caller compute "the latest batch of runs for this PR" (e.g. a cost rollup), `ReviewService.runReview()` now captures one `const ranAt = new Date()` before the create-loop and passes it through `createAgentRun({ ..., ranAt })` for every job in that batch, so "latest round" = the `agent_runs` rows sharing a PR's max `ran_at`. Evidence: `server/src/modules/reviews/service.ts:122`.

### 2026-06-24 — [Decision] `PrMeta`/`PrDetail` fields populated only on the list endpoint must be `.nullish()`, not `.nullable()`

`PrDetail = PrMeta.extend({...})` (`server/src/vendor/shared/contracts/platform.ts:203`), but the `/pulls/:id` detail route builds its response from two code paths — the GitHub-refreshed branch (`return { ...detail, id: pr.id }`) and the offline fallback (a hand-built literal) — neither of which sets `score` or `cost_usd` at all (`server/src/modules/pulls/routes.ts:246`, `:251`). A `PrMeta` field that's only computed by the `/repos/:id/pulls` list route (like `score`, and now `cost_usd`) must use `.nullish()` so the key can be omitted entirely; `.nullable()` requires the key present and breaks response serialization for `PrDetail`. Evidence: `server/src/vendor/shared/contracts/platform.ts:176`.

### 2026-06-24 — [Context] `run_traces.trace` is a frozen JSONB snapshot — mutating `agent_runs` afterward doesn't change it

The trace document persisted to `run_traces` (via `saveRunTrace`) is built once at run completion and never re-derived. Updating `agent_runs.cost_usd` (or any other stat) on an already-completed run has no effect on that run's previously-saved trace — the Run Trace drawer's Stats card will keep showing the value frozen at completion time, even though the timeline (which reads live from `agent_runs`) reflects the update immediately. Confirmed by directly nulling `agent_runs.cost_usd` for a completed run: the timeline showed `–`, the trace drawer still showed the original `$0.0001`. Evidence: `server/src/modules/reviews/run-executor.ts:289`.

### 2026-07-19 — [Context] A skill block needs BOTH enable flags, and reordering must preserve the link flag

Injecting a skill at review time requires `agent_skills.enabled` (does this link
contribute a block) AND `skills.enabled` (is the skill live at all) — they are
independent, and `run-executor.ts:360` filters on both. Because `setSkills`
implements reordering as delete-then-insert, the per-link flags must be read and
re-applied inside the same transaction, or a drag-to-reorder silently
resurrects every link the user had switched off. The transaction also closes a
pre-existing hole where a mid-swap failure dropped all of an agent's links.
Evidence: `server/src/modules/agents/repository.ts:234`,
`server/src/modules/reviews/run-executor.ts:360`.

## Tool & Library Notes

_Nothing recorded yet._

### 2026-07-19 — [Decision] Skill versions snapshot the body ONLY, unlike agent versions

`agent_versions.config_json` captures the whole agent config, so `isConfigChange` bumps the version on any field but `enabled`. `skill_versions` has exactly one payload column (`body`), so `modules/skills/helpers.ts:isBodyChange` bumps only on a changed body — a rename, description/type edit, or `enabled` toggle leaves `skills.version` and the history untouched. Copying the agents rule verbatim would fill the history with snapshots whose bodies are byte-identical. Evidence: `server/src/modules/skills/repository.ts`, `server/src/db/schema/skills.ts:23`.

### 2026-07-19 — [Context] File uploads arrive as base64 JSON, not multipart — and need a per-route `bodyLimit`

`server/package.json` carries no `@fastify/multipart`, and the skills importer deliberately doesn't add one: the client base64-encodes the file into `{ filename, content_base64 }` so the Zod route-validation convention (`fastify-type-provider-zod`) still applies to an upload. The catch is `app.ts:49` sets a global `bodyLimit: 1_048_576`, which a base64-encoded archive (~4/3 expansion) exceeds almost immediately. Fastify accepts `bodyLimit` as a per-route option, so raise it on that route alone rather than widening the app default. Evidence: `server/src/modules/skills/routes.ts`, `server/src/modules/skills/constants.ts`.

## Recurring Errors & Fixes

### 2026-06-27 — [Context] Re-seeding won't refresh PR-level demo data if the PR row already exists

`seed.ts` wraps the review + findings insert in `if (!pr)` (`server/src/db/seed.ts:98`). If the PR was already seeded and then an agent run added new reviews, `pnpm db:seed` silently skips the block. To fully reset: `DELETE FROM repos WHERE full_name = 'acme/payments-api'` (cascades to PRs, reviews, findings), then `pnpm db:seed`.

### 2026-06-27 — [Context] `deriveReviewStatus` returns "reviewed" once `last_reviewed_sha = head_sha`

Running an agent review sets `pull_requests.last_reviewed_sha` to the current `head_sha`, permanently overriding a seeded "needs_review" state. To restore "needs_review" without wiping reviews: `UPDATE pull_requests SET last_reviewed_sha = NULL WHERE number = 482`. Without this reset, re-seeding still shows the PR as "Reviewed" because the status is derived at query time, not stored. Evidence: `server/src/modules/pulls/status.ts`, `server/src/modules/pulls/routes.ts:173`.

### 2026-07-19 — [Context] `skills` has no unique index on `(workspace_id, name)` — seed with select-then-insert

Unlike tables whose composite PK makes `onConflictDoNothing` sufficient
(`agent_skills`, `skill_versions`), `skills` has only a `uuid` primary key
(`server/src/db/schema/skills.ts:6`), so a bare `onConflictDoNothing` never
conflicts and a re-run inserts a duplicate row per skill. Seeding it idempotently
requires select-by-`(workspace_id, name)`-then-insert. This compounds the
2026-06-27 note above: the skills block must also sit OUTSIDE the `if (!pr)`
guard, or an existing PR row skips it entirely. Evidence:
`server/src/db/seed.ts`.

## Session Notes

### 2026-06-27 — Added per-severity findings counts to PR list endpoint

Extended `GET /repos/:id/pulls` to include `findings_critical`, `findings_warning`, `findings_suggestion` from the latest review per PR. Required a subquery joining `reviews → findings` grouped by severity. Both vendor copies (`server/src/vendor/shared/contracts/platform.ts` and `client/src/vendor/shared/contracts/platform.ts`) must be updated in sync — they are committed copies with no automated sync. New fields use `.nullish()` (consistent with `score`, `cost_usd`) so the detail route can omit them without breaking Zod serialization. Evidence: `server/src/modules/pulls/routes.ts:98`.

## Open Questions

_Nothing recorded yet._
