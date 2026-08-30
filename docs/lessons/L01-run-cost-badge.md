# L01 — Run cost badge

> Curriculum entry: `README.md` → *What you build in the course* → **L01:**
> *Run cost badge · severity filter on findings*. This brief covers the
> **cost badge** half only. Severity filter on findings is a separate
> exercise — don't treat it as covered here.

## Why this exists

Every agent review run burns real LLM spend — tokens in, tokens out, dollars
billed. The starter computes that cost today and then throws it away before
it reaches the database. This lesson makes spend visible in the three places
you're already looking when you review a PR:

1. The **Pull Requests list** — which PRs are getting expensive to review?
2. The **Agent Runs timeline** (PR Detail) — what did *this* run cost, next to
   when it ran?
3. The **Run Trace drawer** (single-run sidebar) — alongside Duration, Tokens,
   and Findings, for the run you're currently inspecting.

## What the starter already gives you

Read these before writing anything — the cost number already exists, it's
just dropped on the floor:

- `reviewer-core/src/review/run.ts` (`reviewPullRequest`) accumulates a
  `costUsd` per chunk across the map-reduce and returns it on `ReviewOutcome`.
- `reviewer-core/src/llm/openrouter.ts` prefers OpenRouter's real
  `usage.cost` from the API response, falling back to
  `server/src/adapters/llm/pricing.ts`'s `estimateCost(model, tokensIn,
  tokensOut)` (a static `$/1M tokens` table) when the API doesn't return one.
  Unknown models resolve to `null` — that's an expected, valid state, not a
  bug to suppress.
- `server/src/modules/reviews/run-executor.ts` already destructures
  `outcome.costUsd` out of the review outcome. It just never gets passed
  anywhere after that — **this is the actual gap**, not a missing
  calculation.
- `tokensIn`/`tokensOut` are the working analog for what you're adding back:
  same table (`agent_runs`), same repository method (`completeAgentRun`),
  same two contracts (`RunStats`, `RunSummary`). Cost should follow that
  exact path end to end.

**Gotcha:** `RunStats` and `RunSummary` are Zod contracts that exist as **two
separate committed copies** — `server/src/vendor/shared/contracts/trace.ts`
and `client/src/vendor/shared/contracts/trace.ts`. There's no build step that
syncs them; you edit both, by hand, identically, or the two sides of the API
silently disagree. Same goes for `PrMeta` in `.../contracts/platform.ts`
(also vendored in both packages).

## Shared building blocks — build these once

Don't write three separate cost formatters. Build one formatting function and
one display component, and have all three surfaces consume them.

### `client/src/lib/cost.ts`

New file. Exports:

```
formatCost(usd: number | null): string
```

One magnitude-adaptive rule (not a fixed precision per surface):

| Input | Output |
|---|---|
| `null` | `"–"` |
| `0` | `"$0.00"` |
| `≥ 0.01` | `$X.XXX` (3 decimal places) — e.g. `$0.014` |
| `> 0` and `< 0.01` | `$X.XXXX` (4 decimal places) — e.g. `$0.0013` |

Small per-run costs naturally render with more precision than larger
rollups, from one function. Never render `"$0.00"` for a *missing* value —
that's what `null` → `"–"` is for; a true zero-cost run (e.g. a free model)
is the only case that earns `"$0.00"`.

Add `client/src/lib/cost.test.ts` covering all four branches plus the
boundary (`usd === 0.01` exactly). `src/lib/` doesn't have a `*.test.ts`
file yet — this is a new but consistent pattern, mirroring the co-located
`*.test.tsx` convention `_components/<Name>/` folders already use.

### `client/src/components/RunCostBadge/`

New shared component: `RunCostBadge.tsx` + `index.ts` + `styles.ts`. It does
**not** belong in either page's local `_components/` folder — it's consumed
by both the Pull Requests list and the PR Detail page, so it lives beside
the other cross-route shared components, `client/src/components/app-shell/`
and `client/src/components/diff-viewer/`.

Two layout variants, both built on `formatCost`:

- `variant="compact"` — cost only, e.g. `"$0.014"`. Used on the PR list.
- `variant="withTokens"` — tokens + cost, e.g. `"9,119 tok · $0.0013"`. Used
  on the Agent Runs timeline. This is the same line `git show 58c6ac7`
  removed from `RunHistory.tsx`; generalize it into the badge instead of
  re-inlining it.

Decide and test the empty state yourself: what does `withTokens` render when
`tokensIn + tokensOut === 0`? (The previous implementation omitted the whole
line — that's a reasonable default, but it's your call.)

The Run Trace drawer's Stats card does **not** use this badge — see below.

> Why centralize this at all? The previous implementation's `formatCost`
> lived as a private helper inside `RunTraceDrawer/helpers.ts`, invisible to
> the other two surfaces. Don't reintroduce that duplication.

## Surface specs

### 1. Run Trace drawer (single-run sidebar)

File: `.../pulls/[number]/_components/RunTraceDrawer/_components/TraceBody/TraceBody.tsx`

The Stats row currently renders three `<Stat>` cards (DURATION, TOKENS,
FINDINGS) using the shared `Stat` atom from
`RunTraceDrawer/_components/atoms.tsx`. Add a fourth, between TOKENS and
FINDINGS:

```
<Stat label={t("trace.stat.cost")} val={formatCost(stats.cost_usd)} />
```

Import `formatCost` from `@/lib/cost` (the new shared module), not a local
helper. Add `"cost": "COST"` under `trace.stat` in
`client/messages/en/runs.json` (this key existed before `d45ab0d` removed
it — same key, same place).

No new component needed here — it's a label/value pair, not a row
decoration, so it doesn't go through `RunCostBadge`.

### 2. Agent Runs timeline (PR Detail page)

File: `.../pulls/[number]/_components/RunHistory/RunHistory.tsx`

Each run row has a right-aligned column showing the run's timestamp. Render
the cost badge there:

```
<RunCostBadge variant="withTokens" tokensIn={r.tokens_in} tokensOut={r.tokens_out} usd={r.cost_usd} />
```

(`r` is the `RunSummary` for that row — same object already providing
`r.tokens_in`/`r.tokens_out` today.) This replaces the line `58c6ac7`
deleted; place it where that line used to sit, near `r.ran_at`.

### 3. Pull Requests list

This one has **no prior implementation to restore** — per `58c6ac7`'s own
commit message, the PR-card cost badge was the part of L01 nobody had built
yet. You're adding a real column, end to end:

- `client/src/app/repos/[repoId]/pulls/constants.ts` — add `"cost"` to
  `COLUMN_KEYS`, between `"status"` and `"updated"` (matches the column
  order: PULL REQUEST · AUTHOR · SIZE · SCORE · STATUS · COST · UPDATED).
  Widen the `GRID` template string by one track to fit it.
- `client/src/app/repos/[repoId]/pulls/page.tsx` — **no edit needed.** The
  header row already maps generically over `COLUMN_KEYS` via
  `t(\`list.columns.${key}\`)`; once the key and the i18n label exist, the
  header appears for free. Don't go looking for a header to hand-edit.
- `client/src/app/repos/[repoId]/pulls/_components/PRRow/PRRow.tsx` — new
  cell after the Status badge, before the Updated cell:
  `<RunCostBadge variant="compact" usd={pr.cost_usd} />`.
- `client/messages/en/prReview.json` (`list.columns`, ~line 89) — add
  `"cost": "Cost"`.
- `client/src/vendor/shared/contracts/platform.ts` **and**
  `server/src/vendor/shared/contracts/platform.ts` (`PrMeta`, ~line 157) —
  add `cost_usd: z.number().nullable()` to **both** copies.
- `server/src/modules/pulls/routes.ts` — there's already a block doing
  exactly this shape of work for the Score column (~line 110, comment:
  *"Latest-review SCORE per PR for the list's score ring... one IN-query +
  JS grouping is cheap"*). Add a sibling query: same `IN (...)` over
  `agent_runs.pr_id`, same JS-grouping-after-fetch approach, summing
  `cost_usd` — but scoped to **the latest review round only** (see next
  section), not an all-time total.

## The "latest review round" gap

This is the one open design problem in this lesson — there's no existing
pattern to copy, and you'll need to add a small piece of plumbing.

Today, `ReviewService.runReview()` in `server/src/modules/reviews/service.ts`
creates one `agent_runs` row per target agent in a loop (e.g. Security +
Performance + General reviewers, all from one "Run Review" click). Each
row's `ran_at` is set independently via the schema's `defaultNow()` — there
is no shared identifier tying runs from the same click together.

**Don't repurpose `multi_agent_runs`** — it exists in the schema
(`server/src/db/schema/runs.ts`) but is scaffolding for a later lesson (L07,
multi-agent review), not for this one. Every future-lesson table in this
schema pre-exists on purpose; an unused one isn't a green light to bend it to
a different feature.

The fix shape: capture **one** timestamp before the loop in `runReview()`,
and pass it explicitly as `ranAt` for every run created in that batch
(instead of letting each row default its own). Then "latest review round"
for a PR becomes well-defined: the `agent_runs` rows sharing that PR's
maximum `ran_at` value. Sum `cost_usd` over exactly those rows.

## Suggested build order

1. `lib/cost.ts` + `cost.test.ts`
2. `RunCostBadge` (both variants)
3. Schema: add the column back to `server/src/db/schema/runs.ts`, then
   `pnpm db:generate` inside `server/` to produce the migration — don't
   hand-write the SQL.
4. Repository: `repository.ts` (the `completeAgentRun` signature) and
   `repository/run.repo.ts` (the implementation + the `RunSummary` mapping
   in `listRunsForPull`).
5. `run-executor.ts` — stop dropping `outcome.costUsd`; pass it through every
   `completeAgentRun()` call site (success path, the cancelled/`failAll`
   path, and the catch/error path all call it — match the existing
   `tokensIn`/`tokensOut` handling at each).
6. Both vendored contracts: `trace.ts` (`RunStats` + `RunSummary`) and
   `platform.ts` (`PrMeta`), in both `client/` and `server/`.
7. The "latest review round" fix in `service.ts`.
8. The PR-list aggregation query in `routes.ts`.
9. Wire the three surfaces (TraceBody, RunHistory, PRRow) and the two i18n
   labels.

## Out of scope — don't touch

- **Severity filter on findings** — the other half of L01; a separate brief.
- **`multi_agent_runs` table** — L07 scaffolding (see above).
- **`eval_runs.cost_usd` / `ci_runs.cost_usd`** — already wired and working
  for the eval/CI pipelines; this lesson is about per-PR/per-run review cost,
  a different code path entirely.

## Done when

- [ ] Run Trace drawer shows a COST stat between TOKENS and FINDINGS,
      `formatCost`-formatted, `"–"` when null.
- [ ] Agent Runs timeline shows tokens + cost near each run's timestamp via
      `RunCostBadge variant="withTokens"`, matching the previous behavior.
- [ ] Pull Requests list has a COST column showing the latest review round's
      total, `RunCostBadge variant="compact"`, `"–"` for a PR with no runs.
- [ ] A PR/run with no cost data shows `"–"`, never `"$0.00"` — that's
      reserved for a confirmed zero-cost run.
- [ ] Both vendored copies of `trace.ts` and `platform.ts` match.
- [ ] `RunHistory.test.tsx`, `RunTraceDrawer.test.tsx`, and
      `server/test/contracts.test.ts` are updated for the restored field
      rather than left failing.
- [ ] `cost.test.ts` and a `RunCostBadge` test cover null / `0` / sub-cent /
      normal-magnitude cases.
