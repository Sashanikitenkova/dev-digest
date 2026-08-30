---
name: pr-self-review
description: "Orchestrates DevDigest's existing skills into one pre-merge review gate: classifies the current branch's changed files, runs only the QA/architecture/tech skills that actually apply to what changed, normalizes every finding to Critical/High/Medium/Low, and blocks merge on any confirmed Critical. TRIGGER before: `gh pr create`, `gh pr merge`, `gh pr ready`, or `git push` to `main`/a branch about to be opened as a PR; also on explicit /pr-self-review. SKIP when: the branch diff touches only docs/markdown/config with no `.ts`/`.tsx` source changes — report \"no review needed\" and stop without running the matrix."
user-invocable: true
---

# PR Self Review

Validates the current branch's pending changes locally, before a PR is opened or
merged, by running the subset of DevDigest's existing skills (`.claude/skills/*`)
that actually apply to what changed. This skill does not add new review knowledge —
it's the orchestration layer that decides *which* skills to run against *which*
files, normalizes their findings to one severity scale, and enforces the merge gate.
Never bypass this by hand-picking one skill instead of running the matrix — the value
here is coverage, not any single skill's opinion.

See [`guides/skill-matrix.md`](guides/skill-matrix.md) for the full glob → skill
mapping and [`guides/severity-rubric.md`](guides/severity-rubric.md) for the full
Critical/High/Medium/Low definitions with repo-concrete examples.

## When This Runs

- **Trigger** before `gh pr create`, `gh pr merge`, `gh pr ready`, or `git push` to
  `main` or any branch about to be opened as a PR — run this review first, don't run
  the GitHub action until it reports a verdict.
- **Trigger** on explicit `/pr-self-review`.
- **Skip** when every changed file is docs/markdown/config (no `.ts`/`.tsx` source
  changed) — report "no review needed" and stop before building the matrix.

## Workflow

1. **Determine diff scope.** `git diff $(git merge-base main HEAD)...HEAD`, plus any
   uncommitted working-tree changes — the full set of files the eventual PR would
   contain, not just the latest commit.
2. **Fast-exit check.** Apply the Skip rule above.
3. **Classify each changed file** — see File Classification below.
4. **Build the skill-execution matrix**: baseline QA skills always run; tech/
   architecture skills run once each, against the full set of files that matched
   their glob (never once per file) — see `guides/skill-matrix.md`.
5. **Execute matched skills**, collecting every finding they raise.
6. **Run mechanical checks** for whichever packages have changed files: `pnpm
   typecheck` and `pnpm exec vitest run --exclude '**/*.it.test.ts'` in `server/`;
   `npm run typecheck && npm test` in `reviewer-core/`; `pnpm typecheck` and `pnpm
   test` in `client/`. A failing build/test here is an automatic Critical — no
   semantic judgment needed.
7. **Normalize every finding** to Critical/High/Medium/Low per
   `guides/severity-rubric.md`.
8. **Verify pass on Critical/High findings.** Before finalizing severity, re-check
   each one directly against the actual diff/code (same spirit as `code-review`'s own
   CONFIRMED/PLAUSIBLE step). Downgrade or drop anything that doesn't hold up under
   direct inspection — a false-positive Critical is expensive here because it
   hard-blocks merge, so don't skip this step to save time.
9. **Report** a single Markdown findings table, grouped by severity (most severe
   first): severity, source skill, file, one-line summary, why it matters, and
   verdict (`CONFIRMED`/`PLAUSIBLE`) for anything that went through step 8. Top line
   is one of:
   - `MERGE BLOCKED — N critical issue(s)`
   - `OK TO MERGE (advisory: N high, M medium, K low)`
10. **Merge gate.** If any Confirmed Critical is open: refuse to run `gh pr create`,
    `gh pr merge`, `gh pr ready`, or push to `main`/a protected branch, and state
    exactly which finding(s) block it. High findings get a strong warning and require
    explicit user confirmation before proceeding — not a hard block. Medium/Low are
    informational only and never block anything.
11. **Logged override.** If the user insists on proceeding past an open Critical
    anyway, do not silently comply. Ask for an explicit written justification, then
    surface it (in the PR description, or a commit trailer) rather than quietly
    skipping the gate — an emergency override must stay visible and attributable.
12. **Incremental re-review.** Record the last-reviewed SHA and the prior findings in
    `.claude/pr-self-review-state.json` (gitignored). On a later run against the same
    branch, diff only the commits since that SHA, re-run the matrix against the
    smaller delta, and report each previously-open finding as fixed / still-open /
    new instead of recomputing the full report from scratch. See State File below.

## File Classification

| Bucket | Path rule | Notes |
|---|---|---|
| `backend` | `server/src/**` (excl. `server/src/vendor/shared/**`), `reviewer-core/src/**` | `server/src/modules/repo-intel/**` still counts as `server/` — root `CLAUDE.md` is explicit about this despite the module having its own README. |
| `frontend` | `client/src/**` (excl. `client/src/vendor/**`) | |
| `shared-contracts` | `server/src/vendor/shared/**`, `client/src/vendor/shared/**` | Classify as **both** backend and frontend. Flag explicitly that both vendored copies must be checked for content drift — no automated sync exists between them (`server/INSIGHTS.md`). |
| `tests` | `**/*.test.ts`, `**/*.test.tsx`, `**/*.it.test.ts` | Tracked separately so `verify`'s own "skip test/doc-only diffs" rule and the fast-exit check can apply. |
| `e2e` | `e2e/**` | |
| `docs/config` | `**/*.md`, `**/CLAUDE.md`, `**/INSIGHTS.md`, lockfiles, `.github/**` | Docs/config-only diffs trigger the fast-exit skip. |

## Skill Matrix (summary — full table in `guides/skill-matrix.md`)

- **Always run** (baseline QA, any changed file): `code-review`, `security-review`,
  `simplify` (advisory only).
- **Conditionally run**: `verify` (runtime source changed), `onion-architecture` +
  `fastify-best-practices` + `drizzle-orm-patterns` + `postgresql-table-design`
  (backend paths matched), `frontend-architecture` + `react-best-practices` +
  `next-best-practices` + `react-testing-library` (frontend paths matched), `zod`
  (contract/schema files matched), `typescript-expert` (heuristic — generics-heavy or
  `tsconfig`/`.d.ts` changes only), `security` (auth/session/JWT/upload/input-handling
  files matched, applied adapted to Fastify/Postgres rather than its
  Express/MongoDB examples).
- **Never run for review purposes**: `mermaid-diagram`.
- **End-of-run only, opportunistic**: `engineering-insights`, if the review surfaced a
  genuinely new non-obvious pattern worth recording.

## Severity Rubric (summary — full definitions in `guides/severity-rubric.md`)

- **Critical** — blocks merge: failing build/typecheck/existing test, a bypassed
  `groundFindings()` gate, an onion-architecture dependency-rule break, a new external
  dependency wired with no port interface, a real security exploit path, a
  data-loss-risk migration, or a shared-contract change where the two vendored copies
  go out of sync.
- **High** — strong warning, requires explicit confirmation to proceed.
- **Medium / Low** — informational only, never blocks.

## State File (`.claude/pr-self-review-state.json`, gitignored)

```json
{
  "branch": "feat/example",
  "lastReviewedSha": "<sha>",
  "findings": [
    { "id": "...", "severity": "high", "file": "...", "summary": "...", "status": "open" }
  ]
}
```

On each run: if this file exists for the current branch, diff only
`lastReviewedSha..HEAD` instead of the full merge-base diff, and reconcile
`findings[]` against the new pass (mark fixed/still-open/new) before writing the
updated state and printing the report.

## Rules Checklist

- Never skip the fast-exit check's inverse — a diff with even one `.ts`/`.tsx` change
  always runs the full matrix, not a hand-picked subset.
- A skill that matches N files runs once against all N, never once per file.
- Any Critical finding blocks `gh pr create` / `gh pr merge` / `gh pr ready` / push to
  `main` until it's fixed or explicitly, visibly overridden (see Logged Override).
- Run the step-8 verify pass on every Critical/High before it reaches the report —
  don't report raw, unverified severities.
- Treat `.claude/pr-self-review-state.json` as local, disposable cache: safe to
  delete to force a full cold re-review; never commit it.
- When a new project-local skill is added to `.claude/skills/`, update
  `guides/skill-matrix.md` in the same change — an unmaintained matrix silently goes
  stale.
