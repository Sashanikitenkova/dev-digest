# Handoffs

Exactly what each agent receives, and what to keep from what it returns.

Every agent starts in a **fresh context**. It does not see this session, the
plan you read, the reports before it, or the files already open. It gets its own
system prompt, the `CLAUDE.md` hierarchy — and **not** `INSIGHTS.md`. Anything
you do not put in the dispatch does not exist for it.

Two failure modes to design against:

- **Referring to context it cannot see.** "the findings above", "as discussed",
  "the same plan" — all meaningless in a fresh context.
- **Summarizing the plan.** `plan-verifier` explicitly refuses a summary, and a
  summarized plan silently shrinks what `implementer` builds. Paste it in full.

## implementer — Phase 1

**Give it**

| What | Notes |
|---|---|
| The full text of `plan.md` | Verbatim. Not a path, not a summary |
| `addendum.md` items | As numbered steps `A-1`…, presented as part of the plan |
| Design inventory | Paths it can `Read`, plus one line each on what the design shows |
| The execution mode, restated | `multi-agent` → **write no tests**; `single-agent` → tests inline |

**Keep from its report** — `Changes` (the file table drives delta re-review),
`Plan step status` (anything not `done`), `Deviations`, `Not done / out of
scope` (this is what the reviewers pick up), `Insight candidates` (for the
end-of-run `/engineering-insights`).

## architecture-reviewer — Phase 2

**Give it**: the review target (`the current branch diff`, i.e. `main...HEAD`),
and a one-line statement of what the change is meant to do. Nothing else — it
derives its own scope, and feeding it the plan invites it to grade plan
compliance, which is `plan-verifier`'s lane.

**Do not** ask it about test coverage. At Phase 2 the tests do not exist yet;
their absence is expected, not a finding.

**Keep**: `Findings` (each already carries rule, `path:line`, quoted line,
failure scenario, confidence), `Checked and clean`, `Not examined`.

## plan-verifier — Phase 2 (completeness pass)

**Give it**

- The full text of `plan.md` and `addendum.md`.
- The branch or commit range holding the work.
- **The words "completeness pass"** — explicitly. This is what makes it mark
  `## Tests` rows `deferred to test-writer` rather than `missing`, and run
  `typecheck` only instead of the full suites. Omit it and you get a table
  flooded with false `missing` rows plus a suite run nobody needed yet.

**Keep**: `Plan item verdicts` (every non-`done` row), `Could not verify`,
`Out-of-plan observations`.

## implementer — Phase 3 (remediation)

**Give it**: the Remediation Plan (see
[`remediation-loop.md`](remediation-loop.md)) **plus** the full original plan as
context, so the fix stays inside the change's design.

Say plainly that this is a Remediation Plan — `implementer` accepts that as a
valid plan form, treating each numbered finding as a step and each `path:line`
as its scope.

## test-writer — Phase 4 *(multi-agent only)*

**Give it**

| What | Why |
|---|---|
| The plan's `## Tests` rows | Its work list |
| The plan's `## Traceability` | So each test names the `AC-n` it proves — this is what makes AC verdicts checkable in Phase 5 |
| The changed-file list | From the Implementation Report's `Changes` |
| Whether DB-backed coverage is wanted | Decides `*.test.ts` vs `*.it.test.ts`, and whether Docker is needed |

Skip this phase entirely in single-agent mode — `implementer` already wrote the
tests, and dispatching `test-writer` anyway pays for a second cold context and a
second full suite run to cover the same ground.

**Keep**: `Red tests and suspected product bugs`, `Source changes required (not
made)` — both feed Phase 3 — plus `Verification` and `Not tested / out of scope`.

## plan-verifier — Phase 5 (final pass)

**Give it**: the full `plan.md` and `addendum.md` again, the branch, and the
words **"final pass"**. Do not hand it the Implementation Report as evidence —
it treats reports as claims to be checked, by design, and saying so keeps that
clean.

**Keep**: `Plan item verdicts`, **`Acceptance criteria verdicts`** (the record
this whole pipeline exists to produce), `Commands run`, `Could not verify`.

## doc-writer — Phase 7

**Give it**: the plan, the final Implementation Report, and the intended
audience. It documents what the code actually does — where plan and code
disagree, the code wins and the disagreement is reported.

**Keep**: `Artifacts written`, `Follow-ups for the user` (edits it proposed but
could not make — `README.md`, `CLAUDE.md`, `INSIGHTS.md` are outside its write
scope).

## Persisting reports

Write each returned report to `reports/NN-<agent>.md` as it arrives, numbered in
dispatch order. On a long run this session's context gets summarized; the files
are what let a later phase — or a resumed run — still quote a finding exactly
instead of a remembered approximation of it.
