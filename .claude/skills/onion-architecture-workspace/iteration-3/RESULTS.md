# iteration-3 — the new rule did not change detection

Three runs per version, identical fixture (15 findings, 5 decoys), graded blind.

| | v2 (new) | v1 (old) |
|---|---|---|
| Mean recall | 14.3 / 15 | 13.7 / 15 |
| Decoy false positives | 0 | 1 |
| Runs passing both thresholds | 2 of 3 | 1 of 3 |
| Tokens (mean) | 90,282 | 80,987 |

## F15 — the rule this iteration was built to test: 6/6, no effect

Every run in **both** versions found `digests/helpers.ts:1` importing
`type { MemoryRow }` from `../memory/repository.js`, and every run named
`helpers.ts` rather than merely restating the F06 `service.ts` import.

The rule changed only **prominence**, not detection:

| | severity assigned to F15 |
|---|---|
| v1 | Medium, Should-fix, Should-fix |
| v2 | High, High, Should-fix-before-merge |

Under the stated contract that is not a pass/fail difference. The caveat
recorded in `CHANGES.md` *before* the run is what happened: v1 carries the idea
as background rationale in `drizzle-repository-pattern.md` and
`pitfalls-and-tradeoffs.md`, so it reaches the same conclusion unaided. Stating
it as an enforceable rule in `SKILL.md` raised the volume and nothing else.

A near-miss worth recording: four of the six reviews describe the *F06* import
using F15's exact vocabulary ("reaching into another module's data layer"). None
of those earned F15 — credit came in every case from a separate later finding
quoting the `helpers.ts` line. A grader matching on phrasing would have scored
this iteration wrong.

## Where the rule did pay off — not where the experiment aimed

Two items separate the versions, and neither is F15:

- **F13, the facade↔aggregate type cycle: v2 3/3, v1 1/3.** v1/run-2 actively
  *cleared* it ("the type-only cycle … is erased at compile time and is fine");
  v1/run-3 never saw it and called the split "textbook". v2 flagged it blocking
  or High every time, with the `db/rows.ts` fix.
- **D3, the facade decoy: v2 0 false positives, v1 1.** v1/run-1 filed "facade
  split ahead of the need", quoting the pitfalls-guide warning verbatim — the
  `known_skill_defect` regression the answer key predicts, finally reproducing
  after failing to fire across all six iteration-2 runs.

The plausible mechanism is one frame, not two rules: giving `db/rows.ts` an
enforceable "cross-module row types come from here" statement hands v2 a concrete
correct destination for row types. That makes the cycle legible as a fixable
defect *and* removes the temptation to attack the facade instead. v2 consistently
separates "the split is right" from "the import direction is wrong"; v1/run-1
conflated exactly those two and produced the set's only false positive.

## Cost

v2 is consistently more expensive here: 86.6k–96.9k tokens vs 80.2k–81.7k, up to
+20%. Note this **reverses** iteration-2, where v2 came out 4.8% cheaper. Two
iterations pointing opposite ways on three runs each means the cost signal is
noise; the only safe statement is that v2 reads more skill material.

## What this says about the method

A rule only shows a detection effect when the control genuinely lacks the idea —
not merely the sentence. Before adding a rule to prove a version difference,
check whether the old version already implies it somewhere; here it did, and the
result was predictable in advance rather than discovered.

The rule that *did* discriminate (F13's import-direction rule, added in
iteration-2) is the one v1 had nothing about anywhere. That is the shape of rule
worth adding when the goal is a demonstrable difference.
