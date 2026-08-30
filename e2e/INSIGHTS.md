# INSIGHTS — e2e

Non-obvious decisions, gotchas, and "why is this built this way" for `e2e`.
Read before changing a long-standing convention, or when something behaves
surprisingly that the code alone doesn't explain.

Captured via the `engineering-insights` skill — see
[`.claude/skills/engineering-insights/SKILL.md`](../.claude/skills/engineering-insights/SKILL.md)
for entry format and the append-only rule. Sections are fixed; don't add,
remove, or rename them.

## What Works

_Nothing recorded yet._

## What Doesn't Work

_Nothing recorded yet._

## Codebase Patterns

_Nothing recorded yet._

## Tool & Library Notes

### 2026-07-19 — [Gotcha] `find label "…"` can't reach most DevDigest form inputs — use `find placeholder`

`agent-browser find label <text> fill <value>` resolves through a real
label↔control association. The vendored `FormField`
(`client/src/vendor/ui/kit/FormField.tsx:19`) renders its `<label>` as a
*sibling* of the input with no `htmlFor` and no wrapping, so every field built
with it (the skill editor's Name / Description / Skill body, and the agent
editor's fields) is invisible to a `label` locator — the step fails with "not
found" rather than filling the wrong element. Use `find placeholder "<substring
of the i18n placeholder>" fill "…"` instead — but pass the placeholder's EXACT
string: matching is not substring, despite what this note originally said and
what `README.md` still said (superseded by the 2026-08-29 entry below).
Same caveat for `find role checkbox --name …`: the vendored `Checkbox` is a
`role="checkbox"` button with no accessible name, so target it positionally
(`find first "[role=checkbox]" click`). Evidence: `specs/08-skills.flow.json`.

## Recurring Errors & Fixes

_Nothing recorded yet._

## Session Notes

_Nothing recorded yet._

## Open Questions

_Nothing recorded yet._

### 2026-08-29 — [Gotcha] `find placeholder` matches the placeholder EXACTLY — supersedes the substring claim in the 2026-07-19 note

The 2026-07-19 entry above, and `README.md`, both say placeholder matching is
"substring by default". It is not, and every locator written on that assumption
silently never matches. Measured against agent-browser 0.27.0 with the skills
list open:

| locator | result |
|---|---|
| `find placeholder "Search skills"` | ✗ Element not found |
| `find placeholder "Search skill"` | ✗ Element not found |
| `find placeholder "earch skills"` | ✗ Element not found |
| `find placeholder "Search skills…"` | ✓ Done |

Only the complete string matches — prefix, suffix and interior substrings all
fail. `--exact` is documented as an *option*, which is what makes this
surprising: the default behaves as if it were always on.

Practical consequences for a spec:

- Copy the i18n value **verbatim**, trailing `…` (U+2026) included. This is what
  broke `08-skills.flow.json` at `find placeholder "Search skills"`.
- A **multi-line** placeholder cannot be matched at all reliably — the skill
  body's is `"# Rule\nDescribe the rule…"`. Target the field structurally
  instead (`find first textarea`); `ConfigTab` renders exactly one.

`find role button --name …` is a different code path and does still match on a
substring, so this is specifically about the `placeholder` locator.

### 2026-08-29 — [Gotcha] A click is dispatched at coordinates and is NOT scrolled into view — the default viewport is ~577px tall

`find role button click --name Save` **found the button, exited 0, and did
nothing**: no request was made. It is not a locator failure and not an occlusion
guard — agent-browser dispatches the click at the element's coordinates without
scrolling it into view, and a control below the fold is simply never hit. The
step passes, so the flow keeps going and fails later somewhere unrelated.

A hit-test at the moment of the click showed it exactly — `innerHeight: 577`,
Save at `y: 936`, `elementFromPoint` → `null`:

```
{"innerHeight":577,"found":[
  {"t":"Versions","y":93, "inView":true, "hitIsSelf":false,"hitTag":"DIV."},
  {"t":"Save",    "y":936,"inView":false,"hitIsSelf":false,"hitTag":"null"}]}
```

Note the *second* row: at that height the editor's tab bar is also overlapped by
a sibling `DIV`, so `Versions` was in view yet still unclickable.

What does **not** work: `hover` before the click, `scroll down <px>` (the editor
body is an internal scroll container, so window scrolling moves nothing), and
`find role button focus` (`focus` is listed as an action but exits non-zero).

What works: set a real desktop viewport as the flow's first step —
`{ "cmd": ["set", "viewport", "1440", "1000"] }`. Both symptoms disappear
together, which is the tell that they were one cause. Note the command is
`set viewport`, not `viewport`; a bare `viewport` exits 0 with
"Unknown command", so a mistyped one looks like a passing step.

### 2026-08-29 — [Gotcha] `find text … click` needs a preceding `wait --text` for the same string

`04-pr-findings` and `05-pr-diff` clicked the seeded PR row straight after
`wait --url /pulls`, while `02-repo-pulls-detail` waited for the row's text
first. The URL changes before the list has rendered, so the two specs without
the wait failed intermittently — different one each run, which reads like
infrastructure flakiness rather than a missing wait. `wait --url` is not a
render barrier; pair every `find text … click` with a `wait --text` for the same
string.
