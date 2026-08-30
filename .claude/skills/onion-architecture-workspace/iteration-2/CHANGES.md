# v1 → v2

Three edits, each traceable to a specific failure observed in `../iteration-1/`
or in `../smoke-check/`. The eval set, fixtures and answer key are identical for
both versions — only the skill differs.

## 1. New rule — aggregates must not import back from their facade

`guides/drizzle-repository-pattern.md` gains a "Types flow down, not back up"
section; `SKILL.md` gains a checklist line and a Quick Reference row.

*Why:* F13 (the `memory/repository/*.repo.ts` ↔ `repository.ts` type cycle) was
found by the baseline in the smoke check but **missed** by the run with v1 of
the skill. v1 says nothing about the direction of imports between a facade and
its aggregates.

*Expected effect:* F13 recall goes up. Note this is teaching to a case the eval
scores directly — the honest question is not whether F13 improves but whether
anything else degrades.

## 2. Fix — the skill no longer contradicts itself about facades

`guides/pitfalls-and-tradeoffs.md` gains two clarifications: axis-of-change is a
legitimate reason to split, and the warning governs code you are writing rather
than being a defect to report. `SKILL.md`'s over-engineering line is narrowed and
the facade joins the list of documented compromises.

*Why:* decoy D3. v1's "don't scaffold a facade-over-aggregates repository for a
module that will only ever need two queries" flatly contradicts
`guides/drizzle-repository-pattern.md`, which prescribes that shape. In
iteration-1 both runs **with** v1 quoted that sentence verbatim to attack the
facade the other guide mandates.

*Expected effect:* fewer D3 false positives. This is the change most likely to
show a real quality difference rather than a memorised one.

## 3. New rule — a port names a capability, not a vendor

`guides/layer-model.md` gains "A port names a capability, not a vendor";
`SKILL.md` gains a checklist line and a Quick Reference row.

*Why:* in iteration-1's authoring eval, three of four plans declared a
vendor-neutral port and then wrote `readonly id: 'linear'` into it. Both v1
runs made this mistake; the only plan that avoided it was a baseline that named
the port `LinearClient` honestly.

*Not measured here.* The current eval set is review-only — the authoring case
was dropped when the suite was consolidated. This rule ships on its merits and
awaits an authoring eval.
