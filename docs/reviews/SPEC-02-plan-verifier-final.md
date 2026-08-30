# Phase 5 — plan-verifier, final pass

Run 2026-08-29, after the spend limit (429) that killed the Gate A and Phase 5
passes on the first attempt. `03-gateA-orchestrator.md` and
`04-tests-orchestrator.md` were the orchestrator checking its own pipeline's
output; this file and `07-architecture-reviewer.md` are the independent passes
those two reports recorded as still owed.

Three passes were run in total. The first found real gaps, remediation closed
them, and this is the verdict on the remediated tree.

## Verdict

| Scope | done | partial | missing | deviated | unverified |
|---|---|---|---|---|---|
| **Acceptance criteria (68)** | **68** | 0 | 0 | 0 | 0 |
| Edge cases (25) | 25 | 0 | 0 | 0 | 0 |
| Plan `## Steps` (19) | 15 | 0 | 0 | 4 | 0 |
| Plan `## Tests` (37) | 24 | 10 | 3 | 0 | 0 |
| Plan `## Verification` (15) | 14 | 0 | 0 | 0 | 1 |
| Plan `## Out of scope` (16) | 15 | 0 | 0 | 1 | 0 |
| Plan `## Constraints in force` (33) | 33 | 0 | 0 | 0 | 0 |

**No acceptance criterion is unclosed.** The one edge case the final pass left
`partial` (EC-20's "a brief for the new head is already stored" branch) was
closed afterwards by `brief.it.test.ts` — "hands back an already-stored newer
brief instead of charging again".

`V15` (`pnpm db:migrate`) is `unverified` by design: it is the user's manual
step and is forbidden to an agent.

## What the earlier passes found, and what closed it

| Finding | Closed by |
|---|---|
| `TiktokenTokenizer` degraded silently to `ceil(chars/4)`, so the 8 000-token gate could be enforced by a heuristic it distrusts — AC-13 true by construction, false at runtime | `Tokenizer.degraded` on the port, latched in the adapter; `assertEncoderIntact` in `budget.ts`; called in `service.ts` before the floor check and before provider resolution. **AC-66 + EC-25** (third amendment) |
| `reviewer-core/` edited against the plan's `Out of scope` line and the spec's own `Scope:` line | Third `Amended:` line widening `Scope:` to `reviewer-core/src/llm/openrouter.ts` and its test, for AC-65's diagnosis only, with the reasoning recorded |
| AC-35 ledgered a *failed* issue fetch but recorded nothing when the PR body named no issue | `loadIssue` now ledgers `linked_issue` / `unavailable` / "the pull request body names no issue" |
| AC-62: the per-file 12-hunk cap was disclosed in the prompt but produced no `inputs` entry | `assembleInputs` now ledgers `hunk_headers` / `present` with the count omitted and the cap |
| AC-7, AC-34, AC-36, AC-44, AC-45, AC-48, AC-51, AC-52, AC-58, AC-61, AC-63, AC-64 and the contract-level AC-19/20/20a/20b/21 rested on code-reading | Tests added across `brief.it.test.ts`, `brief-budget.test.ts`, `contracts.test.ts`, `PrBriefCard.test.tsx`, `SmartDiffViewer.test.tsx` |

## Deviations — all five authorized

Every deviation has the same cause: the spec was amended twice after the plan
was written, and the plan text was never revised to match.

| Item | Plan says | Shipped | Authorized by |
|---|---|---|---|
| Step 5 | `BRIEF_MAX_COMPLETION_TOKENS = 1_200` | `4_000` | Amendment 2 (the cap failed 100% of real generations) |
| Step 7 | only two `AppError` codes | a third, `brief_token_count_degraded` | AC-66 |
| Step 10 | one `ExternalServiceError` message | two-branch message on cap exhaustion | AC-65 |
| Step 13 | "comment only — no behaviour change" | the `Tokenizer` port gains `degraded` | AC-66 ("the port shall expose the degraded state") |
| Out of scope #1 | no file in `reviewer-core/` edited | `openrouter.ts` + its test | Amendment 3. `src/index.ts` untouched, so the specific barrel-export prohibition still holds |

**No unauthorized departure from the plan was found.**

## What still rests on structure rather than an observed test

Stated plainly, because it matters more than the 68/68: these are criteria
where a regression would not turn a test red.

1. **AC-11's "and only from"** — the negative half. `BriefParts` being the sole
   assembly input is a real structural guarantee, but nothing fails if a future
   edit adds a section (T22 unwritten).
2. **AC-56 (fetch zero URLs)** — a grep plus a source read. A fetcher added
   through an indirect import would pass the grep (T37 unwritten).
3. **AC-38 (card placement)** — moving the card inside the grid would break it
   silently.
4. **AC-45's page half** — the card's side is tested, the page's single
   `urlWith` → single `push` is not.
5. **AC-31's "naming the resolved provider and model"** — the no-leak half is
   tested twice; the naming half lives only in the source string.
6. **AC-60's six non-title bounds** — only `MAX_TITLE_CHARS` has a test.
7. **AC-29's "anywhere in the studio"**, **AC-37's review-run isolation**,
   **AC-66's end-to-end refusal**, and **EC-6 / EC-11 / EC-23**.

## Unwritten plan test rows — an accepted scoping decision

Remediation was deliberately scoped to AC-level gaps rather than all 37 rows.

- **Unwritten (3):** T22, T30 (EC-23 paid-result logging), T37.
- **Partial (10):** T5, T10, T20, T24, T26, T27, T28, T29, T34, T35.

Every AC those rows were assigned to is `done` by other evidence, which is why
the AC table reads 68/68 while the Tests table does not. The residual exposure
is regression detection, not current correctness.

## Suites

server unit 359 · server integration 128 · client 240 · reviewer-core 85 ·
`tsc --noEmit` clean in both server and client.

One known flake, **not** from this change: `test/context-run.it.test.ts`
(SPEC-01's project-context feature, untouched here) intermittently fails its
`specs_read` assertion under the full parallel lane and passes in isolation and
on re-run. Observed on some full-lane runs and not others; the integration lane
alone was run three times consecutively with no failure.

## Also noted

- The plan's `## Traceability` still says 66 criteria / 23 edge cases. The spec
  now defines 68 and 25, so **AC-65 and AC-66 have no traceability row in the
  plan** and were verified against the spec directly.
- The AC-65 branch matches a literal phrase produced in `reviewer-core`, and the
  consumer test asserts a hand-written copy of the same string — neither test
  fails if the phrase changes in both places at once. A string contract across a
  package boundary.
