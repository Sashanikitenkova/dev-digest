# Cross-model review — SPEC-02 implementation plan

**Reviewed:** `specs/SPEC-02-2026-08-29-pr-why-risk-brief.plan.md` (commit `a5654c3`)
together with the approved `specs/SPEC-02-2026-08-29-pr-why-risk-brief.md`
(commit `ed2bd19`) — the full text of both, not a summary.

**Reviewer:** `openai/gpt-5.6-terra-pro` via OpenRouter — a different model family
from the Claude models that wrote the spec and the plan. Adversarial framing: a
staff engineer with no stake in the plan, told not to praise, not to restate, and
not to propose scope the spec excludes. Probes were aimed at the four areas the
authoring models were most likely to be wrong about: token-budget accounting,
allowlist bypass, cache invalidation, and requirements asserted in prose with no
test that would fail if they regressed.

**Cost:** 148 516 input + 20 013 output tokens, **$0.44**. One call.
Raw output preserved verbatim at [`SPEC-02-cross-model-review-raw.md`](SPEC-02-cross-model-review-raw.md).

**Verdict returned:** *not safe to execute as written* — 10 blocking problems,
5 non-blocking concerns, 24 test gaps, 11 unanswered questions.

That verdict is fair. Eight of the ten blocking findings are real defects, two of
them security-relevant, and none was caught by either the spec's own self-check
or my manual review of the plan.

---

## Blocking findings

| # | Finding | Verdict | Why |
|---|---|---|---|
| 1 | **The 8 000-token budget is counted over the user prompt only.** Step 9 counts `buildBriefUser(...)` output, but `completeStructured` also sends `SYSTEM_PROMPT` and the JSON schema, both of which consume model-input tokens. AC-13's ceiling is on "the assembled prompt", so the claimed hard limit is false as planned. T10 proves only that a counter ran. | **Accepted** | Straightforwardly correct, and it invalidates the feature's headline constraint. The budgeted unit must be the whole payload handed to the provider — system message + user message + serialized schema — recounted after every trim, with a final assertion of `<= 8000`. |
| 2 | **No defined behaviour when mandatory input alone exceeds the budget.** AC-14 forbids ever removing title, author, branch, base, counts, changed-file paths, risk scan, intent, blast summary and endpoints. On a large PR those alone can exceed 8 000 tokens, at which point the plan can neither fit nor comply. T10 makes it worse by asserting protected content survives an "absurdly small budget". | **Accepted** | A genuine, unsatisfiable contradiction between AC-13 and AC-14 that both authoring models missed. Resolution: bound each protected section's own representation *before* assembly (they are all bounded lists — file paths already cap at `MAX_FILES_IN_PROMPT`), and if the floor still exceeds the ceiling, refuse the call with a defined error rather than silently exceed the budget. A refusal is honest; an over-budget call is a broken promise. Requires a spec amendment. |
| 3 | **`MAX_CONTEXT_AGENTS` silently drops required input.** The cap has no value, no deterministic selection order, and no ledger entry, yet AC-11 requires context paths as an input and AC-15 requires a ledger of what was present, removed or unavailable. A silent cap makes the provenance record false. | **Accepted** | Correct. Provenance that lies is worse than no provenance. Either drop the cap or give it a deterministic order and a ledger entry with a reason. |
| 4 | **Concurrent cache misses both pay.** Two simultaneous `POST /pulls/:id/brief` with no cached row both miss and both call the model, violating "one call per distinct PR state". | **Accepted, scoped** | The race is real. The fix is scoped to the deployment that actually exists: an **in-process single-flight** keyed by `prId + headSha`. Durable cross-process coordination is rejected as disproportionate — DevDigest is local-first, one API process on localhost (root `CLAUDE.md`), and the UI already disables the control while a mutation is in flight (AC-51). |
| 5 | **A successful paid call followed by a failed DB write bills twice.** Nothing durable records that the call happened, so the next POST pays again. | **Accepted as a documented limitation** | The analysis is correct. The full fix — durable generation state written before the external call, with recovery semantics — is rejected as disproportionate for a local single-user tool. Instead: log the completed result at error level when the write fails, so the paid output is recoverable from the log, and record the limitation in the spec rather than claiming a guarantee that does not hold. |
| 6 | **A late generation for an old head overwrites a newer-head brief.** Generation A reads `H1`; the PR moves to `H2`; B stores a correct `H2` brief; A finishes and overwrites it with `H1`. The plan's claim that a whole-row replace makes this safe is wrong — whole-row replacement prevents duplicate rows, not lost updates. | **Accepted** | Correct, and it destroys correct data rather than merely wasting a call. The write becomes conditional on the head SHA still being the one generation started from; an obsolete result is discarded, not stored. Cheap, no schema change. |
| 7 | **Head SHA is not a sufficient freshness key.** Editing the PR title, body or linked issue changes the correct "why" without moving the head SHA, so the card shows a stale brief and AC-50's stale notice — which also compares only head SHA — stays silent. | **Accepted as a documented limitation; redesign rejected** | The observation is correct. Head SHA stays the key: it is what the assignment specifies ("the PR ID and the relevant PR commit/state identifier"), and widening to a content hash would spend a model call on every typo fix. Instead the card states which head the brief was generated from, so a reader who just edited the description can see the brief predates their edit, and Regenerate is the escape hatch. The limitation is recorded in the spec instead of being left implicit. |
| 8 | **The reference schema leaves degenerate shapes undefined.** With `.nullish()` fields and an unspecified "at least one present" refinement, `{ file: null }` can pass because the key exists, and `{ line: 42 }` with no file is neither rejected nor renderable as AC-43's `file:line`. | **Accepted** | Correct, and it punches a hole in the feature's central promise. The refinement must require at least one **non-null, non-empty** value, and a `line` is valid only alongside a `file` whose exact file+line pair validates. Explicit cases added for `{}`, `{ file: null }`, `{ line: 1 }`, and mixed valid/invalid fields — a valid field must never rescue an invalid one. |
| 9 | **PR title, author, branch and base are treated as trusted prompt text.** Step 7 calls them a "trusted header line", but the spec's own provenance table marks all four untrusted and US-7 requires PR-authored text to be treated as data. A crafted branch name or title lands outside the injection delimiter. | **Accepted** | A real security finding, and the sharpest one: the plan contradicted the spec's own threat model. All attacker-controlled PR metadata goes inside `wrapUntrusted`; only server-authored labels and the ledger stay trusted. |
| 10 | **`PrRiskBriefRecord` omits `tokens_in` / `tokens_out`.** Step 1's field list lacks both while Step 4 adds the columns and the step claims AC-7 coverage, so the record returned by GET/POST would be missing required metadata. | **Accepted** | Correct — a straight inconsistency between two steps of the same plan. |

## Non-blocking concerns

| # | Finding | Verdict |
|---|---|---|
| 1 | "Progressively fewer files" gives no deterministic retention order, so the same PR state can produce different prompts across runs | **Accepted** — nondeterminism in a cached artifact is a bug; the order must be defined and tested |
| 2 | Symbol-only and endpoint-only references are permitted by AC-20 but have no defined rendering under AC-43's `file:line` format | **Accepted** — specify their text form and route them to the non-navigating path |
| 3 | The rate-limit test covers one route; AC-58 says each generation route | **Accepted** — assert both registrations |
| 4 | "The table has zero rows anywhere" is an assumption, not a verification condition | **Accepted** — drop the claim, and test that a legacy row with a null `head_sha` reads as stale |
| 5 | Grepping the module for `fetch`/`http` is not security evidence — it cannot see a transitive helper | **Accepted as a test improvement** — keep the grep as a cheap guard, and add a behavioural test with adversarial URLs in PR text, issue text and model output. Rejected as a *replacement* for the grep: both are cheap. |

## Test gaps

24 were listed; the material ones are folded into the revision. The most valuable:

- AC-13 is never asserted against the real payload with a final `<= 8000` check.
- Nothing covers the mandatory-input-over-budget case (finding #2).
- AC-11's "**and only from**" restriction is untested — T2 checks that allowed inputs are present, which would not catch extra data arriving through another assembly path. A negative test is the whole point of that criterion.
- `buildLineIndex`'s empty-`newLineNumbers` fallback is untested, so drift from the grounding gate would pass silently.
- No path-integrity cases: case changes, `./` prefixes, `..` components, slash normalisation, renamed and deleted paths.
- AC-2 is never tested directly for `GET` asserting zero LLM calls — T6 tests POST instead.

## What was rejected, and why

Only three things, all on proportionality rather than correctness:

1. **Durable cross-process generation state** (from #4/#5). DevDigest runs one API process on localhost; the root `CLAUDE.md` is explicit that only Postgres is containerised. Building distributed idempotency for a single-process local tool is scope the spec excludes.
2. **Widening the cache key to a content hash** (#7). It would spend a frontier-model call on every description edit, and the assignment names the commit identifier as the key.
3. **Replacing the no-fetch grep with a behavioural test** (non-blocking #5). Both are kept — the grep is a cheap structural guard, the behavioural test is the real evidence.

## Assessment of the exercise

The review paid for itself several times over at $0.44. Findings #1, #2, #8 and #9
are defects that would have shipped: a token budget that did not measure what it
claimed, an unsatisfiable pair of criteria, a reference validator with a hole in
the exact place the feature promises integrity, and PR-authored text outside the
injection boundary in a feature whose own spec marks it untrusted.

The pattern worth keeping: the two Claude models agreed with each other, and the
disagreement that mattered came from outside the family. The spec's self-check
and my own manual pass both missed all four. Notably, three of the four are
*consistency* failures between two documents, or between two steps of one
document — the class of error a model is worst at catching in its own output.
