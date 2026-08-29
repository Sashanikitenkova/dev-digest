# INSIGHTS — client

Non-obvious decisions, gotchas, and "why is this built this way" for `client`.
Read before changing a long-standing convention, or when something behaves
surprisingly that the code alone doesn't explain.

Captured via the `engineering-insights` skill — see
[`.claude/skills/engineering-insights/SKILL.md`](../.claude/skills/engineering-insights/SKILL.md)
for entry format and the append-only rule. Sections are fixed; don't add,
remove, or rename them.

## What Works
### 2026-07-19 — [Pattern] Optimistic drag-reorder needs `setQueryData`, not `invalidateQueries`

`SkillsTab` holds local order state and resets it during render via a
`syncedFrom` sentinel whenever the memoized server view changes. That only stays
flicker-free because `useSetAgentSkills` writes the server's response straight
into the cache with `setQueryData` — the reorder endpoint returns the canonical
ordered link set, so there is nothing to re-fetch. Switching it to
`invalidateQueries` round-trips and visibly snaps the rows back to the old order
before settling. Evidence:
`client/src/app/agents/[id]/_components/AgentEditor/_components/SkillsTab/SkillsTab.tsx`,
`client/src/lib/hooks/agents.ts`.

## What Doesn't Work

### 2026-06-27 — [Mistake] `@testing-library/user-event` is not installed — use `fireEvent` instead

Importing `userEvent` from `@testing-library/user-event` in a test file throws "Failed to resolve import" at build time. The client package only has `@testing-library/react` (which includes `fireEvent`). Use `fireEvent.click(el)` for interaction tests; `userEvent` would need a separate `pnpm add`. Evidence: `client/src/app/repos/[repoId]/pulls/[number]/_components/SeverityFilterBar/SeverityFilterBar.test.tsx:3`.

### 2026-07-20 — [Mistake] An "Enabled" toggle on a create-skill form is inert unless `source` is `manual`

The conventions → skill modal shipped with an Enabled toggle defaulting to on,
and the saved skill came back `enabled: false` every time. `SkillsService.create`
applies `enabled: trusted ? input.enabled ?? true : false` where
`trusted = source === 'manual'`, so any `extracted` / `imported_url` /
`community` skill is forced disabled no matter what the client sends — the same
rule that makes an imported skill land switched off. The fix was to drop the
toggle and state plainly that the skill starts disabled pending review; the
tempting "fix" of sending `source: 'manual'` is wrong, because it would also
strip the `<untrusted>` wrapper from LLM-derived text at review time. Check this
rule before putting an enable control on any create-from-generated-content form.
Evidence: `server/src/modules/skills/service.ts:88`,
`client/src/app/conventions/_components/CreateSkillModal/CreateSkillModal.tsx`.

### 2026-07-19 — [Mistake] Creating a skill with an empty `body` 400s — seed a starter scaffold

The "Create from scratch" path first posted `body: ""`, which fails server-side
Zod: `POST /skills` declares `body: z.string().min(1)`
(`server/src/modules/skills/routes.ts:36`). The fix is a starter markdown
scaffold (`editor.newSkillBody`) rather than relaxing the server guard — an
empty skill body is meaningless, and the scaffold gives the author something to
edit. Any future "create blank X" button should check the server's `min(1)`
constraints first. Evidence:
`client/src/app/skills/_components/SkillsListView/SkillsListView.tsx:44`.

## Codebase Patterns

### 2026-06-24 — [Decision] One magnitude-adaptive `formatCost`, not a fixed precision per surface

`formatCost` (`client/src/lib/cost.ts:11`) picks precision by value, not by caller: `null` → `"–"`, `0` → `"$0.00"`, `>= 0.01` → 3dp, `< 0.01` → 4dp. `RunCostBadge` (`client/src/components/RunCostBadge/RunCostBadge.tsx`) builds on it for the PR-list (`variant="compact"`) and Agent-Runs-timeline (`variant="withTokens"`) surfaces; the Run Trace drawer's `Stat` card calls `formatCost` directly. This is a deliberate change from the feature's original (pre-removal) shape, which had a *separate* 2-decimal `formatCost` living only inside `RunTraceDrawer/helpers.ts` — single-surface, not shared. One consequence: the drawer's COST stat now renders `$0.060` instead of the old hardcoded `$0.06` for the same value, since it goes through the same 3dp-or-4dp rule as everywhere else.

### 2026-07-18 — [Decision] Client-first architecture (all routes `"use client"`) is deliberate, not drift

Every `app/**/page.tsx` is a Client Component with no Server Component data fetching anywhere in `client/` — the app talks to one local Fastify API purely via TanStack Query (`src/lib/hooks/*`). Audited against the `.claude/skills/frontend-architecture` skill and confirmed intentional: mixing server- and client-fetched data would add two caching/hydration models for uncertain payoff on a local-first internal tool. Documented in `client/CLAUDE.md`. Don't convert a page to a Server Component without discussing it first.

### 2026-07-18 — [Pattern] Client-side navigation targets are centralized in `lib/routes.ts`

Added after an audit found the same `/repos/${repoId}/pulls`-style template literals duplicated raw across 9+ files. `lib/routes.ts` exports typed builder functions (`routes.pulls(repoId)`, `routes.pull(repoId, number)`, `routes.agent(id)`, `routes.settings(section)`, etc.) for every `router.push`/`router.replace`/`<Link href>`/breadcrumb target. API resource paths are a separate, already-centralized concern (`lib/api.ts` + `lib/hooks/*`) and were left untouched. New navigation code should add a builder here rather than inlining a template literal. Evidence: `client/src/lib/routes.ts`.

### 2026-07-18 — [Pattern] Framework-agnostic data-layer logic lives in `lib/services/`

`lib/services/runEventsSource.ts` (raw `EventSource` wiring, extracted from `useRunEvents`) and `lib/services/pollingPolicy.ts` (the `refetchInterval` predicates for `usePrActiveRuns`/`usePrRuns`) hold logic that needs to be testable independent of React. Hooks in `lib/hooks/*` should stay thin React-state glue over a `lib/services/*` function once hook-internal logic gets complex enough to want isolated unit tests. Evidence: `client/src/lib/hooks/reviews.ts`.

### 2026-07-20 — [Decision] The Conventions nav entry is a deliberate edit to vendored `nav.ts`

`src/vendor/ui/nav.ts` is a committed copy and normally off-limits, but the nav
registry is the only place a sidebar item can be declared, so adding Conventions
(with its `g c` chord) required editing it. Recorded here so a future resync
against the `@devdigest/ui` source knows this one entry is intentional rather
than drift. Only Conventions was added — the other items in the design mockups
(Eval Dashboard, Memory, Multi-Agent Review…) belong to later lessons and were
deliberately left out. Evidence: `client/src/vendor/ui/nav.ts:33`.

## Tool & Library Notes

### 2026-06-27 — [Pattern] Severity filter as optional prop threaded top-down, not via context

For the `SeverityFilterBar` filter, state lives in `FindingsTab` (aggregates counts from all `ReviewRecord[]` runs) and flows down as `severityFilter?: string | null` through `ReviewRunAccordion → FindingsPanel`. `FindingsPanel` applies it before calling `visibleFindings()`. Toggling the active pill calls `onToggle(null)` to deselect. This keeps the filter global across all run accordions without lifting state above `FindingsTab`. Evidence: `client/src/app/repos/[repoId]/pulls/[number]/_components/FindingsTab/FindingsTab.tsx:69`, `FindingsPanel/FindingsPanel.tsx:31`.

### 2026-06-27 — [Context] PR list header row needs `whiteSpace: "nowrap"` or long column labels wrap

`headRow` in `styles.ts` uses a fixed `gridTemplateColumns` grid. Without `whiteSpace: "nowrap"`, the "PULL REQUEST" label wraps to two lines and the last column ("UPDATED") gets truncated when the table is near full viewport width. Sidebar width is also a factor — reducing it from 264 px to 210 px gained enough space to fit all 8 columns without overflow. Evidence: `client/src/app/repos/[repoId]/pulls/styles.ts:95`, `client/src/vendor/ui/shell/Sidebar.tsx:13`.

### 2026-07-19 — [Context] A component can only use i18n keys from the namespace its tests provide

`RunTraceDrawer/PromptBlock` renders under `useTranslations("runs")`, and
`RunTraceDrawer.test.tsx` wires its `NextIntlClientProvider` with the `runs`
namespace *only*. Reaching into another namespace (e.g. `skills.tokens.badge`)
compiles fine but throws `MISSING_MESSAGE` in that existing test. The `~N tokens`
badge therefore calls `formatTokenEstimate` from `lib/tokens.ts` directly, which
already returns the exact display string. Widening a component's namespace means
updating every test provider that mounts it. Evidence:
`client/src/components/RunTraceDrawer/PromptBlock/PromptBlock.tsx`,
`client/src/lib/tokens.ts`.

### 2026-08-11 — [Context] The `Toggle` primitive has no accessible name — select it by `role="switch"` and its checked state

`Toggle` renders a bare `<button role="switch" aria-checked>` with no label,
`aria-label`, or `id` (`src/vendor/ui/primitives/Toggle.tsx:15`); the caption
next to it is a sibling text node inside the wrapping div, not a `<label>`. So
`getByText("Hide 1 out of scope")` returns the WRAPPER div, and
`.parentElement.querySelector("button")` walks up to the toolbar and grabs the
wrong switch. In a panel with several toggles, the reliable RTL selector is
`getByRole("switch", { checked: true/false })` when the default states differ,
or `getAllByRole("switch")[i]` when they don't. Evidence:
`client/src/app/repos/[repoId]/pulls/[number]/_components/FindingsPanel/FindingsPanel.test.tsx`.

### 2026-08-13 — [Context] The vendored `Donut` formats every legend value as currency

`src/vendor/ui/charts/Donut.tsx` defaults to `valuePrefix="$"` and
`value.toFixed(2)`, so a plain `<Donut segments={counts} />` renders "52
findings" as `$52.00`. This is visible in the product design mockups themselves,
which were clearly drawn with the component untouched. It now takes a `decimals`
prop (default `2`, so existing callers are unaffected); pass
`valuePrefix="" decimals={0}` for counts. Evidence:
`client/src/app/skills/[id]/_components/SkillEditor/_components/StatsTab/StatsTab.tsx`.

## Recurring Errors & Fixes

### 2026-08-13 — [Pitfall] Two `setParam` calls in one handler silently drop the first

The PR detail page's `setParam(key, val)` builds its next URL from
`new URLSearchParams(search.toString())` — a snapshot of the CURRENT render's
search params. Calling it twice in one event handler
(`setParam("tab","findings"); setParam("finding", id)`) makes both calls start
from the same snapshot, so the second `router.replace` wins and the first key's
change is lost. `search` only updates on the re-render AFTER the navigation.
Anything setting 2+ params at once needs a multi-key builder
(`urlWith({ tab, finding })` → one `router.replace`/`push`). The symptom is
maddening: the URL looks "one click behind" rather than plainly broken.
Evidence: `client/src/app/repos/[repoId]/pulls/[number]/page.tsx`.

### 2026-08-13 — [Context] `borderColor` is a shorthand too — it clashes with `borderLeftColor`

`FindingCard/styles.ts` already carried a comment warning not to mix the
`border` shorthand with `borderLeft`, but still set `borderColor` alongside
`borderLeftColor`. React only warns when the value CHANGES on a rerender, so it
stayed silent until a `focused` flip started happening mid-life ("Updating a
style property during rerender (borderColor) when a conflicting property is set
(borderLeftColor)"). Per-side longhands
(`borderTopColor`/`borderRightColor`/`borderBottomColor`) fix it. Evidence:
`client/src/app/repos/[repoId]/pulls/[number]/_components/FindingCard/styles.ts`.

### 2026-08-13 — [Context] Adding a 2nd parameter to a DTO mapper silently breaks `rows.map(mapper)`

`AgentsService.list` was `rows.map(toAgentDto)`. Giving `toAgentDto` an optional
second parameter (`skillsCount`) meant `Array.map` started feeding it the
ELEMENT INDEX, labelling every agent with its position in the list. It
typechecks cleanly — `map`'s index is a `number` and the parameter takes a
`number` — so nothing catches it but a test that asserts the value. When a
mapper used point-free in a `.map()` gains a parameter, convert the call to an
explicit arrow in the same edit. Evidence:
`server/src/modules/agents/service.ts:list`,
`client/src/app/agents/_components/AgentsListView/AgentsListView.test.tsx`.

### 2026-08-12 — [Context] Two hooks in one component share the `lib/api` mock — route by URL, not `mockResolvedValue`

These component tests mock at the network boundary (`vi.mock("lib/api")`), so
once a component calls a SECOND data hook, a blanket `get.mockResolvedValue(X)`
feeds X to both queries. `IntentCard` now calls `usePrIntent` and `usePrRisks`;
the fix is `get.mockImplementation((url) => url.endsWith("/risks") ? … : …)`.
The failure is quiet rather than loud — the second hook gets a well-formed
object of the wrong shape and renders nothing, so the test passes for the wrong
reason until an assertion happens to catch it. Evidence:
`client/src/app/repos/[repoId]/pulls/[number]/_components/IntentCard/IntentCard.test.tsx`.

### 2026-08-12 — [Context] Cost/token totals live on `RunSummary`, not `ReviewRecord` — the brief footnote needs a `run_id` join

`ReviewRecord` (`vendor/shared/contracts/review-api.ts:23-38`) carries verdict,
summary, score and findings but NO cost or token counts; those are on
`RunSummary` (`contracts/trace.ts:96-117`), which also denormalizes `score` and
`blockers`. Any surface wanting "verdict + what it cost" must fetch both
(`usePrReviews` + `usePrRuns`) and join on `review.run_id`, and must tolerate the
run row being absent — deleting a run from history leaves the review intact.
Evidence: `client/src/app/repos/[repoId]/pulls/[number]/_components/PrBriefHeader/helpers.ts:26-33`.

## Session Notes

### 2026-08-13 — Diff severity tags deep-link to their FindingCard

Made the per-line Smart Diff severity tag a button that pushes
`?tab=findings&finding=<id>`; the run accordion holding that finding force-opens,
`FindingsPanel` exempts it from every filter, and `FindingCard` expands and
scrolls itself. Details worth keeping:

- **Testing this needs the right PR.** The seeded demo PR (`acme/payments-api`
  #482) renders NO severity tags, so it cannot exercise the feature and no e2e
  flow can cover it against the current seed. `SmartDiffService.getForPull`
  serves `finding_lines` from the latest review ROUND and deliberately refuses to
  fall back to an older review when that round produced no findings — "a round
  that ran and found nothing is a clean diff". #482's newest round is empty while
  its two findings sit on an older review row, so its `finding_lines` are `{}`.
  Verify on a PR whose most recent round actually produced findings.
- **One tag can stand for several findings.** `SeverityTag` renders one chip per
  severity, and real data has many findings on one line (a local PR had 6
  CRITICALs on `routes.ts:38` from 6 different runs). The chip opens the FIRST of
  its severity, which routinely lives in a run that is NOT the newest — which is
  why the accordion has to open by "does this run hold the target id", not by
  assuming the newest run.
- `FindingCard`'s `expanded` is uncontrolled and seeded once from
  `defaultExpanded`, so a parent cannot open it by re-rendering; the card has to
  push itself open from an effect on `isTarget`.

Evidence: `client/src/components/diff-viewer/CodeLine/CodeLine.tsx`,
`.../_components/ReviewRunAccordion/ReviewRunAccordion.tsx`,
`server/src/modules/smart-diff/service.ts`.

### 2026-08-11 — Intent card on the PR Overview tab + out-of-scope collapse

Added `IntentCard` (rendered FIRST on the Overview tab, above the description,
so the reader can check the system understood the task before weighing what it
says about the code), `lib/hooks/intent.ts`, an `intent` `PromptBlock` in the
Run Trace drawer, and an `out of scope` chip plus a collapse toggle in
`FindingsPanel`. Two details worth keeping: the source chips render `missing`
entries WITH their reason inline rather than hiding them — the card's job is to
show what the system did not know, so an unfetched Notion link and a
plan-not-in-the-clone both stay visible; and the out-of-scope toggle defaults to
collapsed, which is only safe because the server-side filter can never tag a
CRITICAL/security/correctness finding, with the count in the label
("Hide 1 out of scope") keeping the hidden ones present as a number. Evidence:
`client/src/app/repos/[repoId]/pulls/[number]/_components/IntentCard/IntentCard.tsx`,
`.../FindingsPanel/helpers.ts`.

### 2026-06-27 — Severity filter bar + FINDINGS column + layout fixes

Added `SeverityFilterBar` component (pills showing aggregated CRITICAL/WARNING/SUGGESTION counts from all review runs on the Agent runs tab). Clicking a pill filters every `FindingsPanel` in every accordion to that severity; clicking again deselects. Also added a FINDINGS column to the PR list (severity chips with AlertOctagon/AlertTriangle/Lightbulb icons). Sidebar narrowed 264 px → 210 px and PR list grid tightened to prevent "UPDATED" column truncation and "PULL REQUEST" header wrap.

### 2026-07-20 — Conventions triage page + create-skill-from-conventions

Added `/conventions` (thin route → `_components/ConventionsView`), with
`ConventionCard` (confidence bar, `file:line-range` evidence block over the real
snippet, copy button, Accept/Reject) and `CreateSkillModal` (merges accepted
rules into one editable markdown body, saves via `POST /skills`, then appends to
an agent's link set). Two details worth keeping: Accept/Reject are toggles back
to `pending` so triage is reversible without a separate undo, and accepted rows
stay in the visible queue rather than disappearing, because they are exactly
what the "Create skill" button consumes — hiding them would make the "N of M
accepted" counter refer to rows the user can no longer see. Evidence:
`client/src/app/conventions/_components/ConventionsView/helpers.ts`.

## Open Questions

_Nothing recorded yet._
