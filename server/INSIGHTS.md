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

## Tool & Library Notes

_Nothing recorded yet._

## Recurring Errors & Fixes

_Nothing recorded yet._

## Session Notes

_Nothing recorded yet._

## Open Questions

_Nothing recorded yet._
