# INSIGHTS — reviewer-core

Non-obvious decisions, gotchas, and "why is this built this way" for
`reviewer-core`. Read before changing a long-standing convention, or when
something behaves surprisingly that the code alone doesn't explain.

Captured via the `engineering-insights` skill — see
[`.claude/skills/engineering-insights/SKILL.md`](../.claude/skills/engineering-insights/SKILL.md)
for entry format and the append-only rule. Sections are fixed; don't add,
remove, or rename them.

## What Works

_Nothing recorded yet._

## What Doesn't Work

_Nothing recorded yet._

## Codebase Patterns
### 2026-07-19 — [Decision] The skill trust rule lives in `reviewer-core`, not in the server

`formatSkillBlocks` (`reviewer-core/src/prompt.ts:36`) — not the server module
that resolves the DB rows — decides that a `source: 'manual'` skill renders as
plain `### name\nbody` while every other source is wrapped via
`wrapUntrusted('skill:<name>', body)`. It sits here because two callers need the
identical rule: the studio server (skills from Postgres) and the CI runner
(skills from the filesystem). Implementing it on the server side would let the
two silently diverge, and the divergence would be a prompt-injection hole rather
than a cosmetic bug. `assemblePrompt` is unchanged — it still just joins the
`skills` slot. Evidence: `reviewer-core/src/prompt.ts:36`,
`server/src/modules/reviews/run-executor.ts:351`.

## Tool & Library Notes

_Nothing recorded yet._

## Recurring Errors & Fixes

_Nothing recorded yet._

## Session Notes

_Nothing recorded yet._

## Open Questions

_Nothing recorded yet._
