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

### 2026-08-28 — [Mistake] A render-phase sync sentinel keyed on OBJECT IDENTITY discards in-flight user input

`ContextFilesPicker` copied `SkillsTab`'s `syncedFrom` pattern but compared the
memoized rows by identity: `if (syncedFrom !== serverRows) setRows(serverRows)`.
Ticking a checkbox fires a PUT and invalidates the listing to refresh its
`used_by_agents` counts; that refetch returns a NEW response object while the
attachment prop still holds the pre-toggle set, so the sentinel reset local
state and the checkbox silently unticked itself. `SkillsTab` never hit this
because its checkbox reads `row.link.enabled` straight from server data and only
ORDER is mirrored locally — the moment a mirror also holds a value the user can
change, identity comparison is wrong. Fix: compare a value SIGNATURE of exactly
what the rows derive from (attached paths + discovered paths), deliberately
excluding counts, so a refetch that moves only a count changes nothing. Evidence:
`client/src/components/ContextFilesPicker/ContextFilesPicker.tsx` (`signature`),
regression test "does not discard a just-ticked checkbox when the listing comes back".

### 2026-08-28 — [Context] A component tested only with `baseProps()` rendered once cannot catch a state-sync bug

The picker had 10 green tests and still shipped the defect above. Every one of
them built props once and rendered once, so the component never saw a SECOND
render with changed props — which is the only situation a sync sentinel exists
for. Testing a component that mirrors server state into local state requires
`rerender` with a changed prop, and the check that matters is whether local edits
survive it. Corollary worth remembering: a regression test that passes against
the unfixed code proves nothing — revert the fix and watch it fail before
trusting it. Evidence:
`client/src/components/ContextFilesPicker/ContextFilesPicker.test.tsx`.

### 2026-08-28 — [Mistake] A route's `?tab=` whitelist duplicated as a literal made a shipped tab permanently unreachable

`agents/[id]/page.tsx` carried its own `const VALID_TABS = ["config", "skills"]`
and rejects an unknown `?tab=` by falling back to `config`. Adding `context` to
`AgentEditor/constants.ts` `TABS` therefore rendered the tab BUTTON but never the
pane: the click set `?tab=context` and the very next render threw it away. The
symptom reads as "the tab does nothing", which sends you hunting in the tab's own
component — the wrong place entirely. `SkillEditor` never had the bug because it
derives `export const VALID_TABS = TABS.map((t) => t.key)` and the page imports
it. The agent editor now does the same. When a route gates a URL param against a
list, derive that list from the single declaration; two hand-maintained copies of
the same set will drift the first time someone extends one.
Evidence: `client/src/app/agents/[id]/_components/AgentEditor/constants.ts`,
`client/src/app/agents/[id]/page.tsx`.

### 2026-08-28 — [Context] Testing an editor component with `tab` as a prop cannot see the route's tab gate

`AgentEditor.test.tsx` mounted `<AgentEditor tab="config" />` directly, so it
exercised the switch INSIDE the editor and never the page's URL→tab whitelist
that decides which value the editor is handed. The unreachable-tab bug above sat
under a green suite for that reason. Cheapest cover, short of a page test this
client has none of: assert `TABS.every(t => VALID_TABS.includes(t.key))` in the
editor's own suite — it fails the moment the two lists disagree and needs no
App Router mocks. Evidence:
`client/src/app/agents/[id]/_components/AgentEditor/AgentEditor.test.tsx`
("every tab is routable").

### 2026-08-28 — [Mistake] Re-deriving a list that GROUPS selected items moves the row the user just clicked

`ContextFilesPicker` built rows with `toRows` — attached documents first, the
rest alphabetically — and re-derived them whenever the attached set changed.
Correct on a fresh mount, wrong mid-interaction: ticking the third row moved
that document to index 0 and shifted everything below it down, so the checkmark
appeared on row 1 and a different document sat under the cursor. The user
reported it as "I choose one document and it chooses another", which sends you
looking for an index/identity bug in the click handler — there wasn't one; the
click was right and the list moved. The optimistic-cache change made it
immediate rather than causing it: before that, the regroup waited for the server
response. Fix: `mergeRows(prev, files, attached)` reconciles IN PLACE once rows
exist — flags update, vanished rows drop, new files append at the end — and
`toRows` grouping applies only on first mount. Any list that both groups by a
user-toggleable property and re-derives on change has this bug. Evidence:
`client/src/components/ContextFilesPicker/helpers.ts` (`mergeRows`), regression
test "checks the row that was clicked, and leaves the order alone".

### 2026-08-28 — [Pattern] Render the `ApiError`, not a euphemism for it

Both Context tabs mapped every save failure to one fixed sentence
("Couldn't save the change"), so a 404, a 422 and an unreachable API were
indistinguishable on screen — and un-diagnosable from a screenshot. `ApiError`
already carries `status`, `code` and the server's message, and its network
branch produces "Cannot reach the DevDigest engine…", which is precisely the
information the generic copy discarded. The tabs now render the real message
plus the status, keeping the generic sentence only as a fallback for a
non-`ApiError` throw. Worth copying to any surface whose failure a user is
expected to report back. Evidence:
`client/src/app/agents/[id]/_components/AgentEditor/_components/ContextTab/ContextTab.tsx`
(`saveErrorText`), `client/src/lib/api.ts:8-19`.

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

### 2026-08-20 — [Decision] Blast Radius callers link to GitHub, not to the Files-changed tab

A blast caller is an ordinary repo file that usually is NOT part of the PR's
diff, so the in-app diff viewer has nothing to scroll to — the Smart Diff
`JumpTarget` mechanism only addresses files present in `pr.files`. Callers use
`githubBlobUrl(repoFullName, headSha, file, line)` + `MonoLink` instead, the same
pair `FindingCard` uses, pinned to the PR's head sha so the line number stays
accurate. Both inputs are nullable, and `MonoLink` renders a non-navigating
`<button>` when `href` is undefined, so an unloaded repo degrades to plain text
rather than a dead link. Import from `lib/github-urls`, NOT `lib/routes` — both
export a `githubBlobUrl` with different signatures. Evidence:
`client/src/app/repos/[repoId]/pulls/[number]/_components/BlastRadiusPanel/BlastRadiusPanel.tsx:160-172`,
`client/src/lib/github-urls.ts:24`.

### 2026-08-20 — [Pattern] A partial-data caveat belongs ABOVE the data, never instead of it

Blast Radius has three states, not two: `missing` renders `EmptyState` ("nothing
indexed"), while `partial`/`failed` render a banner *followed by the full map*.
The temptation is to reuse the empty state for both, but a partial index has
produced real callers — hiding them trades one wrong claim ("nothing is
affected") for another ("we know nothing"). The server makes this renderable by
sending a structured `blast.index` object; parsing the prose `summary` string for
the word "partial" was the alternative and is exactly what the structured field
exists to avoid. Evidence:
`client/src/app/repos/[repoId]/pulls/[number]/_components/BlastRadiusPanel/BlastRadiusPanel.tsx:186-200`.

### 2026-08-28 — [Decision] Project Context took `g x`, and the g-chord namespace in vendored `nav.ts` is nearly exhausted

`p`/`s`/`a`/`c` are taken across `NAV` and `,` by `SETTINGS_ITEM`, so Project
Context has no mnemonic initial available; `g d` was rejected because a bare `d`
is already "Dismiss finding" in the findings shortcuts. `g x` ("conteXt") was
chosen. Two things a future nav addition should know: adding an item is a
TWO-place edit — the `NAV` group and the `SHORTCUTS` display list, which
duplicates every chord — and this is the second deliberate exception to the
do-not-touch rule on vendored `nav.ts`, after Conventions (2026-07-20), so a
resync against `@devdigest/ui` must preserve both. Evidence:
`client/src/vendor/ui/nav.ts:31`, `:25-54`.

## Tool & Library Notes

### 2026-08-28 — [Context] `agent-browser` drives the real app locally — use it before theorising about a UI bug

jsdom cannot reproduce anything that depends on real browser event semantics:
native HTML5 drag suppressing a click, `<label>` activation forwarding, hit
testing against an icon inside a button. Two plausible-sounding diagnoses in
one session survived code reading and died on contact with a real browser.

`agent-browser` (the CLI behind `e2e/`) is installed globally and does NOT need
the e2e harness — point it at the running dev stack:

```
agent-browser open "http://localhost:3000/skills/<id>?tab=context"
agent-browser eval 'localStorage.setItem("dd-repo","<repoId>")'   # picker discovers from the ACTIVE repo
agent-browser click '[role=checkbox]'
agent-browser eval '(() => [...document.querySelectorAll("[role=checkbox]")].map(b => b.getAttribute("aria-checked")))()'
```

Two gotchas that cost time: a fresh browser profile has no `dd-repo` in
localStorage, so the active repo falls back to the first one from the API —
the seeded `acme/payments-api`, which has no clone and therefore renders
"0 of 0 attached" rather than the documents you expected. And the API's
`x-ratelimit-limit` / `x-ratelimit-remaining` response headers are the cheapest
way to tell whether a running server is the old build and whether a 429 is
actually in play, without burning the budget to find out.

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

### 2026-08-20 — [Context] `useTranslations`' `t` does not satisfy `(k: string, v?: Record<string, unknown>) => string`

Passing next-intl's `t` into a helper typed with a `Record<string, unknown>`
values parameter fails with TS2345: next-intl's `TranslationValues` indexes to
`TranslationValue` (string | number | Date | ReactNode), and `unknown` is not
assignable to it. Don't widen the helper's signature to `any` — pass a
pre-bound formatter callback instead (`(count: number) => t("k", { count })`),
which keeps the helper pure and testable and keeps the key literal next to its
namespace. Evidence:
`client/src/app/repos/[repoId]/pulls/[number]/_components/BlastRadiusPanel/BlastGraph.tsx:38-48`.

### 2026-08-28 — [Context] A shared component mounted under TWO i18n namespaces has to own a third

`ContextFilesPicker` renders inside both the agent editor (namespace `agents`)
and the skill editor (namespace `skills`). Declaring either one compiles but
throws `MISSING_MESSAGE` in whichever test provider supplies the other, so it
declares its own `context` namespace for its chrome and takes the caller-specific
heading and note as `title` / `note` props. This is the general form of the
2026-07-19 `PromptBlock` entry: that one says a component may only use keys from
the namespace its tests provide; the rule for a component with N mount points is
that shared copy needs a namespace of its own and per-caller copy arrives as
props. Evidence: `client/src/components/ContextFilesPicker/ContextFilesPicker.tsx:54`, `:245`.

## Recurring Errors & Fixes

### 2026-08-29 — [Pitfall] Annotating a `styles.ts` const as `CSSProperties` and spreading it breaks `tsc` with TS2742

Sharing the common half of two sibling styles looks like it wants a hoisted
`const base: CSSProperties = {...}` — a member of `s` cannot spread another
member while `s` is still being initialised, so hoisting is genuinely required.
But annotating that const widens every member that spreads it to csstype's own
type, and `tsc --noEmit` then fails the whole package with
`error TS2742: The inferred type of 's' cannot be named without a reference to
'.pnpm/csstype@…/node_modules/csstype'`. Nothing in the file looks wrong, and
`vitest` passes — only `pnpm typecheck` catches it. Use `satisfies` instead:
`const emptyText = { fontSize: 13, lineHeight: 1.5 } satisfies CSSProperties;`
type-checks the literal without widening it, so the spread stays nameable. This
is why the pre-existing `summaryFont` in the same file is unannotated. Evidence:
`client/src/app/repos/[repoId]/pulls/[number]/_components/PrBriefCard/styles.ts:7-12`.

### 2026-08-28 — [Pitfall] A `<label>` around a `<button role="checkbox">` fires the handler TWICE

`Checkbox` (vendored kit) wraps its button in a `<label>`, which makes that
button the label's LABELED CONTROL — so a click bubbles to the label and the
label re-dispatches a synthetic click back to the button. The handler runs
twice, against two different renders of `checked`: `onChange(false)` then
`onChange(true)`. The toggle nets to zero and the box simply refuses to change.

Two things make this expensive to find:

1. **It is environment-dependent.** The HTML spec says a label must NOT forward
   when the click targets interactive content, but the carve-out is applied
   inconsistently once the real target is a non-interactive descendant (here,
   the check icon inside the button). jsdom fires once. The Chrome build behind
   `agent-browser` fires once. The user's Chrome fired twice. A green test run
   and a clean browser-driven repro are therefore NOT evidence of absence.
2. **The symptom names the wrong layer.** "The checkbox does nothing" reads as
   a state or save bug and sends you to the cache and the API, where nothing is
   wrong.

What actually found it: a temporary on-screen counter incremented inside the
toggle handler. It read **+2 per click** in the running app, which converted an
untestable theory into a fact in one screenshot. Reach for that early when a
handler-level bug will not reproduce locally — an on-screen counter beats
another round of reasoning about someone else's browser.

Fix: `e.preventDefault()` in the button's `onClick` — label forwarding is the
click's DEFAULT ACTION, so cancelling the event suppresses the second dispatch;
harmless on `type="button"`. Plus `pointerEvents: "none"` on the check icon so
the button is the target in both states. Both live in the vendored
`client/src/vendor/ui/kit/Checkbox.tsx` and are DELIBERATE edits to keep across
a resync (same standing as the Conventions entry in `nav.ts`). Note this
stacked on top of [the `draggable` row bug](#) below — one checkbox, two
independent causes; fixing the first only exposed the second.

### 2026-08-28 — [Pitfall] One write per click + a shared rate limit = a checkbox that unticks itself

The context picker fired one PUT per checkbox. The API's rate limit is global
and per IP, the whole studio is one localhost IP, and the pollers spend most of
the budget before the user clicks anything — so a burst of ticks came back
`429`, the optimistic write rolled back, and the boxes emptied. The symptom is
indistinguishable from a broken checkbox, which is why it reads as a state race
and sends you to the cache layer, where the bug is not.

Three properties fix it, and they are separable:
1. **Debounce the NETWORK, never the UI.** The cache is written on the click;
   only the request waits (~400 ms). Coalescing is safe here only because the
   endpoint is a whole-set replace — last write wins by construction.
2. **Roll back to the pre-BURST value.** Once writes coalesce, the "previous"
   captured per-request is itself optimistic; rolling back to it restores a
   state that was never saved. Keep the baseline from the start of the burst.
3. **Retry 429/5xx, and invalidate on terminal failure.** Not invalidating the
   attachment key is right on the SUCCESS path (a stale response would beat the
   optimistic write) and wrong on the error path, where nothing optimistic is
   left to protect and the alternative is a list that lies about what is stored.

Also flush the pending write on unmount — an author who ticks a box and
immediately leaves the tab has still made the change. Evidence:
`client/src/lib/hooks/context.ts`, `client/src/lib/hooks/context.test.ts`.

### 2026-08-28 — [Pitfall] A `draggable` row eats the clicks on its own checkbox

Both drag-reorder lists (`ContextFilesPicker`, `SkillsTab`) put
`draggable={!filtering}` on the whole ROW. A `draggable` ancestor makes the
browser start a native HTML5 drag on the first `mousemove` after `mousedown`,
and a drag that starts dispatches NO `click` — so a checkbox pressed with a
pixel of pointer drift silently did nothing, and drift that crossed into the
next row fired `onDrop` and REORDERED the list instead of ticking the box. The
user-visible symptom is "the checkbox only works sometimes", which reads as a
state race and sends you to the mutation/cache layer, where the bug is not.

Fix: arm the drag from the handle. `draggable={!filtering && dragArmed === i}`,
the ☰ handle sets `dragArmed` on `mouseDown`, and a `window` `mouseup`/`dragend`
listener clears it so a press that wanders off the handle cannot leave a row
armed. `mousedown` is discrete, so React flushes it synchronously and the
attribute is `true` before the first `mousemove` — no gesture is lost. While
there, `dragstart` must also call `dataTransfer.setData(...)`: Firefox refuses
to start a drag that sets no data, so reordering never worked there at all.

jsdom CANNOT reproduce this — it dispatches `click` directly and never
simulates a native drag — which is why 26 green picker tests sat on top of a
broken checkbox. Pin the DOM contract instead: at rest, no row is
`draggable="true"`. Evidence:
`client/src/components/ContextFilesPicker/ContextFilesPicker.tsx:237`,
`client/src/app/agents/[id]/_components/AgentEditor/_components/SkillsTab/SkillsTab.tsx`.

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
