# onion-architecture — eval workspace

Measures what the `onion-architecture` skill actually changes about an agent's
behaviour, against a baseline that is deliberately *not* naive.

## The baseline question

`server/CLAUDE.md` and `reviewer-core/CLAUDE.md` already state several of the
skill's rules (adapters behind the DI container, `modules/index.ts` registration,
`*.it.test.ts` naming, mandatory `groundFindings()`), and they auto-load. So
"skill vs. nothing" would flatter the skill.

Both configurations therefore run inside the real repository with CLAUDE.md
available. The only difference:

- `with_skill` — told to read `.claude/skills/onion-architecture/` and follow it.
- `without_skill` — told that `.claude/skills/` is off-limits (the fixture path
  under it is explicitly exempted so the files under review stay readable).

What is left is the skill's *marginal* value over the docs the repo already has.
Four rules live only in the skill:

1. Don't flag the intentional compromises (whole-`Container` injection,
   row-types-as-DTOs).
2. `reviewer-core/src/llm/openrouter.ts`'s `openai` import is a documented,
   legitimate exception.
3. Port in `vendor/shared/adapters.ts` comes *before* the adapter.
4. Don't reach past a repository facade into `repository/<aggregate>.repo.ts`.

The hypothesis is therefore about **precision, not recall**: the skill should
mostly find the same defects but report fewer false ones.

## Fixtures

Written to be indistinguishable from this repo's real code — same JSDoc-header
convention, `.js` on relative imports, `import * as t from '.../db/schema.js'`,
`{routes,service,repository,constants,helpers}.ts` module shape. Both planted
modules are built on real, currently-unused tables (`digests`, `memory`).

**No fixture comment hints at a planted defect.** Header comments describe the
feature only; a scan for rule statements and `TODO`/`FIXME`/`violation` markers
is part of the setup. The defects are visible from the code or not at all.

| Fixture | Planted defects | Traps that must NOT be reported |
|---|---|---|
| `digests/` | route does data access + branches on domain state; service queries Drizzle directly; service constructs `OctokitGitHubClient` off `process.env`; service reaches past `MemoryRepository` into `search.repo.ts`; module unregistered | whole-`Container` injection; `DigestRow` as DTO |
| `summarize.ts` | builds its own provider from `process.env`; reads skill bodies off disk; returns findings without `groundFindings()`; hardcoded model; never exported | the real `llm/openrouter.ts` `openai` import |
| `memory/` | the facade↔aggregate type-import cycle only — the layering is otherwise correct | facade over aggregates; whole-`Container`; degrade-gracefully catch |
| `digests-service.test.ts` | DB-backed test named `*.test.ts` instead of `*.it.test.ts` | — |

The `memory` module is the highest-signal fixture, but a caveat learned from iteration 1:
it is clean *structurally*, not functionally — runs surfaced real
correctness bugs in it (an `eq(repoId, …)` filter that hides NULL-scoped rows, an
unguarded `markUsed` await, the raw embedding column on the wire, no ANN index).
Those are legitimate findings. What this fixture measures is therefore narrower
and sharper: any *structural/layering* finding against it is a false positive.

The fourth eval has no fixture — it asks for a new Linear integration and checks
the *order* of construction (port → adapter → container wiring → consumption).

## Layout

The eval cases themselves no longer live here. They moved into the skill so it
travels self-contained:

```
../onion-architecture/evals/
    eval.md                      task prompt, run protocol, thresholds
    expected-findings.json       answer key — 14 findings, 5 decoys
    fixtures/                    one mirrored PR tree under review
```

`evals/` is excluded from a packaged `.skill` by `package_skill.py`'s
`ROOT_EXCLUDE_DIRS`, so the cases ship through git while the package stays lean.

What remains here is the setup and the history of the first benchmark:

```
GRADING.md                       the grading contract given to grader agents
iteration-1/benchmark.{json,md}  aggregated results
iteration-1/<eval>/<config>/run-N/
    outputs/                     the agent's review.md or plan.md
    grading.json                 per-assertion verdicts
    timing.json                  tokens + wall clock
```

`iteration-1/` is a record of the FIRST layout: four separate eval cases, three
fixture trees, assertions rather than a findings key. Its
`*/eval_metadata.json` files are kept as written so the grades stay auditable —
they do not describe the current `evals/` set.

Review prompts never say "onion", "layer", or "architecture" — that hint would
leak the answer to the baseline and invalidate the comparison.

## Re-running

Fixtures live outside `server/` and `reviewer-core/`, so neither package's
tsconfig or vitest config picks them up; `pnpm typecheck` in both packages is
clean with them present. Point new runs at `iteration-N/` and aggregate with
skill-creator's `scripts.aggregate_benchmark`.
