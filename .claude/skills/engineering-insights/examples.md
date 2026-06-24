# Examples — engineering-insights

One good/bad pair per category, each "good" example independently verified
against this repo's actual source — not invented. "Bad" fails the
anti-vagueness test from `SKILL.md` step 2: if it would be obvious to
anyone who just read the code, it doesn't belong here.

## Pattern (What Works)

Bad:
> Citation grounding is a good idea.

Good:
> ### 2026-06-22 — [Pattern] Grounding gate runs as a single post-step
>
> `groundFindings()`/`groundingSummary()` run exactly once, after
> map-reduce or single-pass both finish and get merged — never duplicated
> per strategy. Evidence: `reviewer-core/src/review/run.ts:196-198`.

## Mistake (What Doesn't Work)

Bad:
> Don't trust the model's output.

Good:
> ### 2026-06-22 — [Mistake] Assumed `verdict` was recomputed like `score`
>
> Spent time looking for a `verdictFromFindings()` helper that doesn't
> exist — `score` is recomputed from surviving findings, but `verdict` is
> passed through from the model unchanged via `...merged`. A model
> returning the wrong verdict reaches the UI as-is.
> Evidence: `reviewer-core/src/review/run.ts:208`.

## Decision (a choice + the reason)

Bad:
> We decided to use a path alias instead of a package.

Good:
> ### 2026-06-22 — [Decision] `reviewer-core` stays a tsconfig path alias, not a publishable package
>
> Chosen so there's zero build step between editing the engine and seeing
> the change in `server` — the package intentionally never emits `dist/`.
> Adding a build step here would also require updating the consumer's
> path alias, so don't add one without doing both.
> Evidence: `reviewer-core/CLAUDE.md` (Non-default conventions),
> `server/CLAUDE.md` (Non-default conventions).

## Context (codebase convention / tool quirk / recurring error+fix)

Bad:
> Migrations need to be run manually.

Good:
> ### 2026-06-22 — [Context] Migrations are never applied on boot
>
> `pnpm dev` does not run `db:migrate` — if a fresh clone's API throws
> relation-does-not-exist errors, the fix is always `pnpm db:migrate` in
> `server/`, not a server restart.
> Evidence: `server/CLAUDE.md` (Gotchas), `CLAUDE.md` (Non-default
> conventions).
