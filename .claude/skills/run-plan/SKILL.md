---
name: run-plan
description: "Executes an already-approved DevDigest Implementation Plan end to end: dispatches implementer, runs architecture-reviewer and plan-verifier in parallel as one review gate, drives a capped remediation loop until the blocking findings are closed, then test-writer, final verification, the merge gate and docs. TRIGGER only on explicit /run-plan — this spends many agent invocations and is never auto-delegated. SKIP when there is no written Implementation Plan: spec-creator and implementation-planner are run separately, by hand, and this command starts after both."
user-invocable: true
---

# Run Plan

Executes an approved Implementation Plan through the agent pipeline. You are the
**orchestrator**: subagents do not nest, so every dispatch happens from this
session, and the report one agent returns is the only thing the next one gets.

This command owns the *execution* half of spec-driven development. It does not
write specs and does not plan — `spec-creator` and `implementation-planner` are
run separately, by hand, before this. See
[`.claude/agents/README.md`](../../agents/README.md) for the whole composition.

Two guides carry the detail:
[`guides/remediation-loop.md`](guides/remediation-loop.md) (how findings get
closed) and [`guides/handoffs.md`](guides/handoffs.md) (what each agent is
handed, exactly).

## Hard rules

- **Never re-plan.** If the plan is wrong, stop and say so. Rewriting it here
  silently replaces a human-approved artifact with your own judgment.
- **Never author requirements.** `specs/**` is read-only to this whole command.
- **The plan text is handed over in full, every time.** `plan-verifier` refuses
  a summary and receives the plan **twice**. Never paraphrase it into a dispatch.
- **No git state changes.** No commit, no push, no PR, no branch switching
  beyond the Phase 0 guard's *offer*. The run ends on a changed working tree.
- **Never exceed the remediation cap** (3) without the user saying so.
- **Report failures as failures.** A red suite, an exhausted cap, or an open
  Critical is the result — never summarize one into a green closing line.

## Arguments

```
/run-plan <path-to-plan.md> [--design <path>]... [additional requirements prose]
```

- **First `.md` path** → the Implementation Plan. Required.
- **`--design <path>`** (repeatable) → a screenshot, export, or reference file.
  Also accept a bare image path anywhere in the arguments.
- **Everything else** → the addendum (see Phase 0.2).

If no plan path is given, look for `.claude/runs/*/plan.md`; if exactly one
unfinished run exists, offer to resume it. Otherwise ask for the path — do not
guess which plan was meant.

## Phase 0 — Intake

**0.1 — Read the plan and check its shape *before spending anything*.**

Required sections: `## Execution mode` · `## Steps` · `## Tests` ·
`## Traceability` · `## Out of scope` · `## Verification`.

| Missing | What you do |
|---|---|
| `## Traceability` | **Stop and ask.** Without it `plan-verifier` cannot produce acceptance-criteria verdicts, which is the thing spec-driven development exists for. Offer: re-run `implementation-planner`, or proceed knowingly with plan-item verdicts only |
| `## Execution mode` | Treat as single-agent and say so |
| anything else | Note it in the final report; proceed |

**0.2 — Turn the addendum into numbered steps.** Extra requirements go to
`addendum.md` as `A-1`, `A-2`, … — each with files to touch and a done-when,
in the shape of a plan step. `implementer` is plan-bounded: free-form prose
outside the plan is something it will correctly ignore. Numbering it keeps the
contract bypass visible and lets `plan-verifier` check it as its own items.

**0.3 — Ingest designs.** `Read` each one. A path that does not resolve, or a
bare Figma URL, is a blocking question — ask for an export, never guess.

**0.4 — Branch guard.** If `HEAD` is `main`, **stop**. This is not a formality:
`architecture-reviewer` and `plan-verifier` both derive their target from
`git diff main...HEAD`, which on `main` is empty — both would report clean and
the gate would pass anything. Offer to create a branch.

**0.5 — Create the run directory** (below) and write `state.json`.

## Execution mode — obey the plan, do not impose one

| Plan says | What this command does |
|---|---|
| **multi-agent** | `implementer` writes code only; every `## Tests` row is `test-writer`'s, in Phase 4 |
| **single-agent** | `implementer` writes tests inline; **Phase 4 is skipped**; Gate A still runs |

## The run directory

`.claude/runs/<slug>/` — gitignored, alongside the existing
`.claude/pr-self-review-state.json`:

```
plan.md          # verbatim copy of the approved plan
addendum.md      # numbered extra steps, or absent
state.json       # phase · iteration · open items · dispatched reports
reports/NN-<agent>.md
```

Persist every agent report as it returns. This is what makes the run survive its
own length — agent reports reach only this session, whose context gets
summarized on a long run — and what makes it resumable and auditable.

`state.json`:

```json
{
  "plan": ".claude/runs/<slug>/plan.md",
  "mode": "multi-agent",
  "phase": "remediation",
  "iteration": 1,
  "cap": 3,
  "openItems": [{ "id": "AR-2", "source": "architecture-reviewer",
                  "severity": "High", "path": "server/src/...:42",
                  "status": "open" }]
}
```

## Phase 1 — Implement

Dispatch `implementer` with the full `plan.md`, the `addendum.md` items, and the
design inventory. Persist its Implementation Report.

## Phase 2 — Gate A

Dispatch `architecture-reviewer` **and** `plan-verifier` (completeness pass)
**in a single message, in parallel**. Both are read-only and take the same
branch diff, so they cannot conflict; running them in sequence only costs
wall-clock. Tell `plan-verifier` explicitly that it is a *completeness pass* —
that is what makes it mark `## Tests` rows `deferred to test-writer` instead of
drowning the table in false `missing`.

## Phase 3 — Remediation loop

The core of this command. Full rules in
[`guides/remediation-loop.md`](guides/remediation-loop.md); the shape:

**Exit when all three hold** — zero `Critical`/`High` architecture findings ·
zero `missing`/`partial`/`deviated` plan items · everything else (`Medium`,
`Low`, `unverified`) recorded as accepted debt, not silently dropped.

**Each iteration:** compose a Remediation Plan → dispatch `implementer` with it
→ delta re-review only the reviewer that still had open items, scoped to the
changed files → increment `iteration`.

**Cap: 3.** On exhaustion, stop and hand the open list to the user. Never loop
past it on your own judgment.

## Phase 4 — Tests *(multi-agent only)*

Dispatch `test-writer` with the plan's `## Tests` rows **and its
`## Traceability`**, so each test names the `AC-n` it proves. It runs the full
suite.

Its red tests (suspected product bugs) and `Source changes required (not made)`
feed back into Phase 3, against the same cap.

## Phase 5 — Final verification

Dispatch `plan-verifier` in **final pass**: the full `plan.md` plus
`addendum.md`, the `AC-n` rows, and the full suites. Any remaining
`missing`/`partial` returns to Phase 3 against the same cap.

## Phase 6 — Merge gate

Run `/pr-self-review`. It already knows to skip what this pipeline paid for
upstream — the architecture skills, and the mechanical checks when
`plan-verifier` ran them at the same `HEAD`. A confirmed Critical goes back to
Phase 3.

## Phase 7 — Close out

`doc-writer` (only if behaviour has settled), then `/engineering-insights` in
this session. Then **remind the user to set `Status: implemented`** on the
spec — no agent can: `doc-writer` cannot write `specs/`, and `spec-creator`
only ever writes `draft`.

## Final report

```
## Outcome            — completed | stopped at <phase> | cap exhausted
## Plan               — path, execution mode, sections missing
## Iterations         — n of 3, what each one closed
## Acceptance criteria— the AC verdict counts from the final plan-verifier
## Verification       — package · command · pass | fail | skipped (no Docker)
## Accepted debt      — Medium/Low findings and unverified items left open
## Still open         — anything blocking, with its path:line
## Not done           — phases skipped and why
## For the user       — migrations to run, Status to flip, follow-ups
```

`Accepted debt` and `Still open` stay in the report even when empty. An
orchestrator that only reports what it finished is indistinguishable from one
that quietly stopped looking.
