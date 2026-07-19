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
of the i18n placeholder>" fill "…"` instead; placeholder matching is substring by
default and reads the attribute, so it still works after the field has a value.
Same caveat for `find role checkbox --name …`: the vendored `Checkbox` is a
`role="checkbox"` button with no accessible name, so target it positionally
(`find first "[role=checkbox]" click`). Evidence: `specs/08-skills.flow.json`.

## Recurring Errors & Fixes

_Nothing recorded yet._

## Session Notes

_Nothing recorded yet._

## Open Questions

_Nothing recorded yet._
