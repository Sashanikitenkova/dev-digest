# The Remediation Loop

How review findings get closed in `/run-plan`. This is the part of the pipeline
that has no owner without it: `architecture-reviewer`, `plan-verifier` and
`test-writer` can only *report*, and a plan-bounded `implementer` will correctly
refuse to fix anything the original plan never mentioned. The Remediation Plan
is the artifact that turns findings into work it is allowed to do.

## What blocks, and what does not

| Source | Verdict / severity | Action |
|---|---|---|
| `architecture-reviewer` | `Critical` | **Blocks.** Always iterate |
| `architecture-reviewer` | `High` | **Blocks.** Always iterate |
| `architecture-reviewer` | `Medium`, `Low` | Accepted debt → final report |
| `architecture-reviewer` | `Adjacent, out of lane` | Never actioned here. Report only |
| `plan-verifier` | `missing`, `partial`, `deviated` | **Blocks** |
| `plan-verifier` | `unverified` | Accepted debt, **but** name what evidence would settle it |
| `plan-verifier` | `done` | Nothing |
| `test-writer` | red test = suspected product bug | **Blocks** |
| `test-writer` | `Source changes required (not made)` | **Blocks** |
| `test-writer` | `Not tested / out of scope` | Accepted debt |
| `/pr-self-review` | confirmed `Critical` | **Blocks** |
| `/pr-self-review` | `High` and below | Accepted debt; surface it prominently |

A `deviated` verdict includes *something shipped that the plan put out of
scope*. Closing it usually means **removing** code, not adding it — read the
verdict before assuming the fix is additive.

## Composing the Remediation Plan

Hand `implementer` a numbered list and nothing else. Each item:

```
R-<n>  <source agent> / <finding id>
  severity : Critical | High   (or verdict: missing | partial | deviated)
  where    : <path:line>
  rule     : <the rule quoted from the finding>
  change   : <what must become true — not a patch>
  done-when: <observable condition>
```

Rules for composing it:

- **One finding, one item.** Never merge two findings because they touch the
  same file — they close independently.
- **Carry the `path:line` verbatim.** `implementer` starts cold and never sees
  the review's reasoning. An item that is not actionable from its own text is
  a defective item.
- **Say what must become true, not how.** The finding's "suggested direction"
  is one line by design; do not expand it into a patch.
- **Never add anything of your own.** Not an adjacent bug you noticed, not a
  cleanup. The list is exactly the blocking findings. `implementer`'s "no scope
  creep" rule then means *nothing beyond these items*.
- **Include the original plan text** in the dispatch as context, so the fix
  stays inside the change's design rather than inventing a new one.

## Delta re-review

After `implementer` returns, re-verify — but scope it:

- Re-dispatch **only** the agent that still had open items. If
  `architecture-reviewer` was clean and only `plan-verifier` had `missing` rows,
  do not re-run the architecture review.
- Scope it to **the files the remediation touched**, from the Implementation
  Report's `Changes` table — not the whole branch diff.
- **Exception — re-run the full review** when a fix moved code across a layer
  boundary: a new adapter, a module registration, a file that moved between
  `routes.ts` / `service.ts` / `repository.ts`, or any change under
  `vendor/shared/**`. Those are exactly the cases where a narrow diff hides the
  violation, because a layering break is visible in the whole file.

## The cap

**Three iterations.** Count every entry into the loop — from Gate A, from
`test-writer`, from the final `plan-verifier`, from `/pr-self-review`. They all
share one counter.

On exhaustion: **stop**. Report `cap exhausted`, list every still-open item with
its `path:line`, and hand the decision to the user. Do not start a fourth
iteration because the last one "was close" — that judgment is exactly what the
cap exists to remove.

The user may say to continue. That is a fresh mandate, recorded in
`state.json`, not a reset of the cap.

## Escalating instead of burning an iteration

Some items cannot be closed by iterating, and spending the cap on them is the
loop's main failure mode.

- **Twice `blocked` for the same reason** → do not send it a third time.
  Escalate it to the user immediately, with the implementer's stated reason.
- **The finding disputes the plan itself** — the reviewer is right and the plan
  is wrong — → stop. This needs `implementation-planner`, not another fix
  round, and re-planning is not this command's lane.
- **The fix needs a migration, a dependency, or a command the user must run** →
  `implementer` cannot apply those. Escalate with the exact command.
- **Two findings contradict each other** → escalate both. Do not pick a winner.

Every escalation goes into the final report's `Still open`, never into
`Accepted debt` — debt is something judged acceptable, not something that
defeated the loop.

## Recording each iteration

Append to `state.json` before dispatching the next agent, so an interrupted run
can be picked up:

```json
{ "iteration": 2,
  "closed":   ["AR-1", "PV-3"],
  "stillOpen":["AR-4"],
  "escalated":[{ "id": "AR-7", "reason": "blocked twice: needs a migration" }] }
```
