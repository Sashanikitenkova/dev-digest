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

### 2026-08-11 — [Decision] The scope filter is pure code with a hard escape hatch, never an LLM judgment

`applyScopeFilter` demotes findings the PR's derived intent puts out of scope,
but `isScopeExempt` runs FIRST and makes anything CRITICAL, `security`, `bug`,
or a full-file kind untouchable — a plain severity/category predicate with no
model call and no configuration. It lives in reviewer-core, not the server, for
the same reason `formatSkillBlocks` does: the CI runner calls
`reviewPullRequest` too, and a server-side filter would leave CI applying
un-softened severities. The scope list originates in attacker-controlled PR
text, and the Oct 2025 "Attacker Moves Second" result broke 12 published
prompt-injection defenses at >90% success against adaptive attackers — so
anyone tempted to "improve" the fuzzy token matcher by asking a model to judge
scope would reintroduce exactly the failure mode this design avoids. It also
demotes rather than deletes: `output.length === input.length` always holds.
Evidence: `reviewer-core/src/scope.ts:129`, `reviewer-core/test/scope.test.ts`.

## Tool & Library Notes

### 2026-08-11 — [Context] `npm run typecheck` does NOT typecheck the tests

`tsconfig.json`'s `include` is `["src/**/*.ts"]`, and vitest transpiles without
type-checking, so a type error under `test/**` is invisible to the only static
gate this package has. Running `tsc` over `src` plus `test` surfaces a
pre-existing `TS7006` (implicit `any`) at `test/run.test.ts:111` that the normal
build has never reported. Don't assume a green `typecheck` says anything about
test-file types. Evidence: `reviewer-core/tsconfig.json:28`.

## Recurring Errors & Fixes

_Nothing recorded yet._

## Session Notes

_Nothing recorded yet._

## Open Questions

_Nothing recorded yet._
