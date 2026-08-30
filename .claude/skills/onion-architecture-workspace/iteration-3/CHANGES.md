# iteration-3 — one added rule, one added finding

Everything from iteration-2 stays. This iteration adds a single rule to v2 and a
single matching violation to the fixture, to test whether an explicitly stated
rule changes what gets caught.

## The rule (v2 only)

**Never import another module's data layer.** Cross-module row types come from
`db/rows.ts`; cross-module data comes from that module's service or a
`container.*Repo` getter.

Added to `SKILL.md` (a checklist line plus a Quick Reference row) and to
`guides/drizzle-repository-pattern.md` (a new "Across modules, row types come
from `db/rows.ts`" section).

### Why this rule and not the broader one

The brief was a rule against a module importing a file from another module. That
blanket rule is **false for this repository** and was not written. Cross-module
imports are normal and widespread here — over twenty of them, including
`brief/service.ts` composing `IntentService`, `BlastService`, `RisksService` and
`ContextService`, and `reviews/run-executor.ts` using `intent` and `context`
helpers. A skill carrying the blanket rule would flag all of those as defects.

What the repository *does* hold, and documents in `db/rows.ts`'s own doc comment,
is the narrower prohibition above. The evidence:

- zero cross-module imports of any `repository/<aggregate>.repo.ts`;
- exactly one cross-module `repository.ts` import in the entire tree
  (`reviews/run-executor.ts:13`, taking `PrIntentRow` from `intent/repository.js`);
- `container.agentsRepo` / `reviewRepo` / `skillsRepo` exist precisely so modules
  do not reach into each other's folders for persistence.

## Honest note on the separation between versions

v1 is not blind to this idea. The phrase "without importing another module's data
layer" appears in v1's `drizzle-repository-pattern.md` and
`pitfalls-and-tradeoffs.md` — but only as the *rationale for why `db/rows.ts`
exists*, inside the row-types-as-DTOs discussion. v1 never states it as a
prohibition and has nothing about it in `SKILL.md`, which is the file always in
context.

So this measures **"stated as an enforceable rule" vs "present as background
rationale"**, not "rule vs no rule". v1 catching F15 some of the time is a
plausible outcome, not a broken experiment.

## The new finding

**F15** — `server/src/modules/digests/helpers.ts:1` imports
`type { MemoryRow } from '../memory/repository.js'`.

Deliberately placed in `helpers.ts`, not `service.ts`, and deliberately a *type*
import: it is quiet, and it is a different file from F06 so the two cannot be
closed by one finding. F06 remains the loud value-import of `nearest` from
`memory/repository/search.repo.js` in `service.ts`.

The answer key spells out the distinction and instructs the grader to credit F15
only if `helpers.ts` is named. Recall threshold moves to 14 of 15.
