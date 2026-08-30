# v2 vs v1 — result: indistinguishable

Three runs per version, one identical fixture tree, same answer key
(`../../onion-architecture/evals/expected-findings.json`), graded blind to
version.

| | v2 (new) | v1 (old) |
|---|---|---|
| Recall | 40/42 (95.2%) | 40/42 (95.2%) |
| Decoys flagged (false positives) | 0 | 0 |
| Findings per review (mean) | 17.0 | 21.7 |
| Tokens (mean) | 80,162 | 84,200 |
| Wall clock (mean) | 200 s | 232 s |
| Tool calls (mean) | 15.7 | 21.3 |

Eleven of the fourteen findings were caught by all six runs. Only three moved,
and they scatter across versions rather than clustering:

| Finding | v2 | v1 |
|---|---|---|
| F11 hardcoded model id | 2/3 | 3/3 |
| F12 not exported from the barrel | 2/3 | 2/3 |
| F13 facade↔aggregate type cycle | 3/3 | 2/3 |

## What happened to each change

**1. New rule — aggregates must not import back from the facade.**
Weak positive that does not survive scrutiny. v2 caught F13 3/3 against v1's 2/3
— a one-run delta on a finding the answer key scores directly, which is teaching
to the test. And v2 paid for it: run-1 dropped F11 *and* F12, so the net is zero.

**2. Fix — the pitfalls/drizzle contradiction.**
Untestable here, because the regression it targets did not fire. All three v1
runs cleared the facade explicitly; one quoted `pitfalls-and-tradeoffs.md` as the
authority for *not* flagging it — the opposite of the iteration-1 behaviour that
motivated the fix. A fix cannot be measured against a control arm that no longer
fails. D3 was high-variance in iteration-1 too (flagged 3 of 4 runs there, 0 of 6
here), so the honest reading is that D3 is a noisy signal, not that v1 was fine.

**3. New rule — a port names a capability, not a vendor.**
Not exercised at all. The eval set is review-only; the authoring case that
surfaced this failure was dropped when the suite was consolidated. The only trace
is v2/run-2 noting "no new port was needed".

## The one real difference

v2 is terser and cheaper at equal recall: 17 findings vs 21.7, −4.8% tokens,
−32 s, and a third fewer tool calls. The plausible mechanism is that explicit
rules save the agent from re-deriving conventions by reading neighbouring
modules. On three runs per version, with overlapping ranges, this is a trend and
not a result.

## What this says about the eval set, not the skill

Eleven of fourteen findings are saturated — every run gets them, so they cost
grading effort and carry no signal. The set currently cannot distinguish two
skill versions. To do that it would need:

- an authoring case (restored) so change 3 is measurable at all;
- decoys that actually fire in the control arm — D3's iteration-1 failure has not
  reproduced in six attempts;
- harder or more numerous non-saturated findings, since F11/F12/F13 alone leave
  the comparison inside noise;
- more runs per version: n=3 cannot resolve a one-finding difference.

## A grading-definition gap found along the way

v1 explicitly cleared 15/15 decoys, v2 13/15. Both v2 gaps are benign — one decoy
simply never came up, and one review cleared `memory/service.ts` as a whole file
without naming `embedOrNull`. The answer key does not say whether a blanket
file-level clear counts as clearing the decoy inside it. That single judgement
call produces the 13-vs-15 gap, so the key should define the granularity before
this number is used to compare anything.
