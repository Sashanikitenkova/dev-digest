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

## Recurring Errors & Fixes

_Nothing recorded yet._

## Session Notes

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
