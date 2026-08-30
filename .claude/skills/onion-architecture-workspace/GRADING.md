# Grading contract — iteration 1

Read `agents/grader.md` from the skill-creator plugin for the output format, then
apply the rules below. They override anything in the generic grader guidance that
conflicts.

## What counts as a false positive

ONLY these two things:

1. The review flags a listed **decoy** from the eval's `answer_key.decoys` as a
   defect, a violation, or something to "fix"/"refactor".
2. The review asserts a rule this repository does not actually hold.

Everything else is a legitimate finding — including every entry in
`answer_key.legitimate_extra_findings`. Those are real defects in the fixture
code that runs surfaced; the fixtures were not perfect and that is expected.
Do NOT penalise a review for finding them, and do NOT count them as noise.

## Naming a decoy is not the same as flagging it

Several reviews explicitly *clear* a decoy — "I did not flag whole-`Container`
injection, it is a documented compromise". That is the opposite of a false
positive and must PASS the corresponding `Does NOT flag …` assertion.

Read the framing carefully before deciding. The distinction that matters:

- **Cleared** → named as fine / intentional / not-a-defect → assertion PASSES.
- **Flagged** → listed among the problems, given a severity, or paired with a
  "should be changed to…" → assertion FAILS.
- **Hedged** → raised as a judgement call, explicitly marked non-blocking, and
  not proposed as a change → assertion PASSES, but record it verbatim in
  `eval_feedback` because the hedge is itself an interesting result.

## Severity is not the test

A review that buries a planted violation among twenty findings still detected it.
Grade detection, not prominence. Note prominence in `eval_feedback` instead.

## Required output

One `grading.json` per run directory (sibling to `outputs/`), with the
`expectations` array using exactly the fields `text`, `passed`, `evidence` — the
viewer depends on those names. Include the `summary` block with `passed`,
`failed`, `total`, `pass_rate`.

Also add, per run, a top-level `"finding_counts"` object:

```json
"finding_counts": {
  "total_findings": 0,
  "planted_detected": 0,
  "decoys_flagged": 0,
  "structural_findings": 0
}
```

`structural_findings` counts findings about layering, file placement, module
shape, or dependency direction — the category this skill governs. For the
`memory-clean` eval that number is the headline metric, because the module is
structurally correct: any structural finding against it is a false positive,
even though the module does contain genuine functional bugs.
