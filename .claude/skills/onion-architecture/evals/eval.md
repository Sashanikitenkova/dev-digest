# Eval — onion-architecture

Measures whether this skill changes how an agent reviews backend code in this
repository. Ships with the skill so it can be re-run after any edit to
`SKILL.md` or `guides/`.

## The task prompt

Give the agent exactly this, substituting the two paths:

> A teammate has opened a PR adding two new server modules and one new file in
> the review engine. The proposed files are in `FIXTURE_DIR` — treat them as
> the contents of `server/` and `reviewer-core/` in this repository. Review this
> PR before it is merged. Report every problem you find, most important first;
> for each one give the file and line, say what is wrong, and say what should be
> done about it. Write your review as markdown to `OUTPUT_DIR/review.md`.

Keep it neutral. Do **not** add the words *onion*, *layer*, or *architecture* —
that hint leaks the answer to the baseline and destroys the comparison. The
whole question is whether the skill makes the agent look at layering unprompted.

## Run protocol

Two configurations, identical except for one paragraph.

**with_skill** — prepend:
> Before you start: read `.claude/skills/onion-architecture/SKILL.md` and
> whichever files under that skill's `guides/` folder are relevant, and follow
> that guidance in your review.

**without_skill** — prepend:
> Do NOT read anything under `.claude/skills/` — that directory is off-limits
> for this task. Everything else in the repository is fair game.
>
> (The fixture path under it is the one exception; read those files.)

Both run inside the real repository with its `CLAUDE.md` files available. That
is deliberate: `server/CLAUDE.md` and `reviewer-core/CLAUDE.md` already state
several of this skill's rules, so a blind baseline would flatter the skill. What
this eval measures is the skill's **marginal** value over the docs already here.

`expected-findings.json` is off-limits to both configurations. It holds the
answer key; an agent that reads it scores itself.

Two runs per configuration is the practical minimum — code review is
high-variance, and a one-run difference of "three findings vs two" is noise.

## Fixtures

`fixtures/` mirrors the repository layout. It is one PR spanning three areas:

| Path | Role |
|---|---|
| `server/src/modules/digests/` | the main offender — eight findings |
| `reviewer-core/src/review/summarize.ts` | engine-purity offender — five findings |
| `server/src/modules/memory/` | structurally correct; carries most of the decoys |
| `server/test/digests-service.test.ts` | test-placement finding |

The modules are built on real, currently-unused tables (`digests`, `memory`) so
they read as this codebase rather than as a synthetic exercise.

**No fixture comment hints at a planted defect.** Header comments describe the
feature only. The defects are visible from the code or not at all — that is the
point, and it must survive any edit to these files.

`memory/` is structurally clean but does contain genuine functional bugs (a
`repoId` filter that hides NULL-scoped rows, an unguarded `markUsed` await, the
raw embedding column on the wire). Those are legitimate findings and are neither
rewarded nor penalised. Only the two entries in the answer key that concern its
structure — the import cycle (F13) and the facade decoy (D3) — are scored.

## Scoring

Two independent thresholds; the eval passes only if both hold.

| Metric | Threshold | Why |
|---|---|---|
| Recall over the 15 findings | ≥ 0.90 (14 of 15) | catches a skill that stopped working |
| False positives over D1, D3, D4, D5 | 0 | catches a skill that creates noise |
| Blocking findings on D2 | 0 | scored separately — see the answer key |

Recall is the weaker of the two. In the first benchmark (16 runs) **both**
configurations found 100% of the planted defects, because the repo's own
`CLAUDE.md` files carry much of the rule set. Treat recall as a regression
guard, not as evidence the skill adds value.

Precision is where the difference showed up: with the skill, reviews explicitly
cleared the documented compromises ("row-types-as-DTOs is an accepted trade-off
here"); without it, they filed them as defects with a refactor plan.

A review that stays silent scores well on precision and badly on recall — which
is why both thresholds must be checked together.

## Grading

Grade each run against `expected-findings.json`. The distinctions that matter:

- **Cleared vs flagged.** A review saying "I did not flag whole-`Container`
  injection, it is documented" is the opposite of a false positive. A review
  listing it among the problems is one. Read the framing before deciding.
- **Detection, not prominence.** A finding buried at position 19 still counts.
- **Out-of-key findings are free.** The fixtures contain real correctness bugs.
  Finding them is neither credited nor penalised.

Grade blind to configuration where possible — the folder name must not influence
a verdict.

### A known blind spot in the precision metric

A decoy passes both when a review *explicitly clears* it and when a review
*never mentions it*. Those are not the same thing: the first shows the reviewer
looked and knew, the second may just mean it never looked. In practice runs with
the skill produce an explicit "checked and clean" section naming the compromises
they left alone, and runs without it stay silent — yet both score identically.

If you want that captured, add a separate positive credit for explicitly
clearing a decoy, and report it alongside the false-positive count rather than
folding it in. Do not turn silence into a failure: a review that simply had
nothing to say about a decoy has not done anything wrong.

## Known limitation

D3 (the repository facade) is expected to fail even with the skill.
`guides/pitfalls-and-tradeoffs.md` warns against scaffolding a facade for a
small module, which contradicts `guides/drizzle-repository-pattern.md`
prescribing exactly that shape. Runs with the skill have quoted the warning to
attack the facade. This is a defect in the skill, not in the eval; D3 stays as
its regression test until the contradiction is resolved.
