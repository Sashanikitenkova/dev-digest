# INSIGHTS — client

Non-obvious decisions, gotchas, and "why is this built this way" for `client`.
Read before changing a long-standing convention, or when something behaves
surprisingly that the code alone doesn't explain.

Captured via the `engineering-insights` skill — see
[`.claude/skills/engineering-insights/SKILL.md`](../.claude/skills/engineering-insights/SKILL.md)
for entry format and the append-only rule. Sections are fixed; don't add,
remove, or rename them.

## What Works

_Nothing recorded yet._

## What Doesn't Work

### 2026-06-27 — [Mistake] `@testing-library/user-event` is not installed — use `fireEvent` instead

Importing `userEvent` from `@testing-library/user-event` in a test file throws "Failed to resolve import" at build time. The client package only has `@testing-library/react` (which includes `fireEvent`). Use `fireEvent.click(el)` for interaction tests; `userEvent` would need a separate `pnpm add`. Evidence: `client/src/app/repos/[repoId]/pulls/[number]/_components/SeverityFilterBar/SeverityFilterBar.test.tsx:3`.

## Codebase Patterns

### 2026-06-24 — [Decision] One magnitude-adaptive `formatCost`, not a fixed precision per surface

`formatCost` (`client/src/lib/cost.ts:11`) picks precision by value, not by caller: `null` → `"–"`, `0` → `"$0.00"`, `>= 0.01` → 3dp, `< 0.01` → 4dp. `RunCostBadge` (`client/src/components/RunCostBadge/RunCostBadge.tsx`) builds on it for the PR-list (`variant="compact"`) and Agent-Runs-timeline (`variant="withTokens"`) surfaces; the Run Trace drawer's `Stat` card calls `formatCost` directly. This is a deliberate change from the feature's original (pre-removal) shape, which had a *separate* 2-decimal `formatCost` living only inside `RunTraceDrawer/helpers.ts` — single-surface, not shared. One consequence: the drawer's COST stat now renders `$0.060` instead of the old hardcoded `$0.06` for the same value, since it goes through the same 3dp-or-4dp rule as everywhere else.

## Tool & Library Notes

### 2026-06-27 — [Pattern] Severity filter as optional prop threaded top-down, not via context

For the `SeverityFilterBar` filter, state lives in `FindingsTab` (aggregates counts from all `ReviewRecord[]` runs) and flows down as `severityFilter?: string | null` through `ReviewRunAccordion → FindingsPanel`. `FindingsPanel` applies it before calling `visibleFindings()`. Toggling the active pill calls `onToggle(null)` to deselect. This keeps the filter global across all run accordions without lifting state above `FindingsTab`. Evidence: `client/src/app/repos/[repoId]/pulls/[number]/_components/FindingsTab/FindingsTab.tsx:69`, `FindingsPanel/FindingsPanel.tsx:31`.

### 2026-06-27 — [Context] PR list header row needs `whiteSpace: "nowrap"` or long column labels wrap

`headRow` in `styles.ts` uses a fixed `gridTemplateColumns` grid. Without `whiteSpace: "nowrap"`, the "PULL REQUEST" label wraps to two lines and the last column ("UPDATED") gets truncated when the table is near full viewport width. Sidebar width is also a factor — reducing it from 264 px to 210 px gained enough space to fit all 8 columns without overflow. Evidence: `client/src/app/repos/[repoId]/pulls/styles.ts:95`, `client/src/vendor/ui/shell/Sidebar.tsx:13`.

## Recurring Errors & Fixes

_Nothing recorded yet._

## Session Notes

### 2026-06-27 — Severity filter bar + FINDINGS column + layout fixes

Added `SeverityFilterBar` component (pills showing aggregated CRITICAL/WARNING/SUGGESTION counts from all review runs on the Agent runs tab). Clicking a pill filters every `FindingsPanel` in every accordion to that severity; clicking again deselects. Also added a FINDINGS column to the PR list (severity chips with AlertOctagon/AlertTriangle/Lightbulb icons). Sidebar narrowed 264 px → 210 px and PR list grid tightened to prevent "UPDATED" column truncation and "PULL REQUEST" header wrap.

## Open Questions

_Nothing recorded yet._
