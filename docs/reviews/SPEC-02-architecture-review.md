# Gate A (re-run) — architecture-reviewer, independent

Run 2026-08-29, after the spend limit that killed the first attempt
(see `03-gateA-orchestrator.md`, which was the orchestrator reviewing its own
pipeline's output and is superseded for the architecture half by this file).

Scope: the working tree on `feat/spec-02-pr-why-risk-brief` — 33 changed/new
files across `server/`, `client/`, `reviewer-core/`. The code was uncommitted,
so `git diff main...HEAD` (markdown only) is NOT the review surface; the
reviewer worked from `git status --short` + unstaged `git diff` + direct reads
of every untracked file. Every file in the path set was read in full.

## Findings — 1

| Severity | Confidence | path:line | Finding |
|---|---|---|---|
| Medium | 8 | `server/src/adapters/tokenizer/index.ts:47-51` | `TiktokenTokenizer` latched `broken = true` and degraded permanently to `ceil(chars/4)` if the BPE ranks failed to load — silently, with no signal to the caller. `budget.ts:18-20` states that heuristic is "wrong by tens of percent on code and on paths, which is exactly what this feature is made of", so `assertFloorFits`/`assertWithinBudget` would then gate on an under-count and let a genuinely over-8 000-token payload reach the model instead of refusing it per AC-61. |

**Status: FIXED.** The `Tokenizer` port now exposes an optional
`readonly degraded?: boolean` (optional so the function-backed mock counters
every test injects still satisfy the port); `TiktokenTokenizer` latches it;
`budget.ts` gained `assertEncoderIntact`, which `service.ts` calls after forcing
encoder initialisation and before the floor check, so a degraded counter refuses
the generation with a 503 rather than enforcing an 8 000-token promise with a
number it does not believe. The repo-map renderer, whose budget is advisory,
still ignores the flag and never throws. Recorded in the spec as **AC-66** and
**EC-25** (third amendment). Covered by `server/test/brief-budget.test.ts`,
including a case that kills the real encoder and asserts both the fallback and
the flag.

## Checked and clean

- **Onion layering** — `routes.ts` (Zod params, delegates only) → `service.ts`
  (port-typed `container.*`, never imports `db/schema`, constructs no adapter) →
  `repository.ts` (sole Drizzle access, verified by grep). Module shape mirrors
  `modules/blast/`. Registered once in `modules/index.ts`.
- **The grounding gate is not bypassable** — exactly one model-call site
  (`service.ts:226`), exactly one write site (`service.ts:313`), with
  `buildAllowlist` + `buildValidLineIndex` + `validateItems` strictly between
  them and no path around. No other module writes `pr_brief`.
- **`Tokenizer` port** — reached via `container.tokenizer`, never instantiated
  in the module; the only production construction site is `container.ts:138`.
- **Frontend placement** — `PrBriefCard/` owns its helpers, styles, barrel and
  colocated test; one hook file per resource over `lib/api`; navigation goes
  through the page's `router.push(urlWith(...))`, with `focusParams` as the one
  construction site for that URL shape.
- **Vendored copy discipline** — `risk-brief.ts`, `brief.ts`, `platform.ts` and
  `index.ts` byte-identical across `server/src/vendor/` and `client/src/vendor/`;
  `client/src/lib/feature-models.ts` agrees with both `platform.ts` copies.
- **Test placement** — the three `brief-*.test.ts` touch no Container or DB;
  `brief.it.test.ts` is the only DB-backed file and injects the mock into BOTH
  the `openai` and `openrouter` slots per the 2026-08-11 INSIGHTS rule.
- **`reviewer-core` purity** — the `openrouter.ts` change is diagnostic-message
  only; no DB, GitHub or filesystem access introduced.
- **Migration/schema consistency** — `0016` matches the new nullable columns;
  journal entry correct.

## Not examined

`modules/{risks,blast,intent,context}` (consumed but unchanged),
`reviewer-core/src/llm/structured.ts` (referenced, not in the changed set),
`meta/0016_snapshot.json` (drizzle-kit generated; existence checked, not diffed).

## Raised, deliberately not a finding

The budget is asserted once on the initial payload; `openrouter.ts`'s repair
loop appends an assistant turn plus a reprompt per retry (max 2) without
re-checking the growing payload. No single stated requirement is violated — the
spec scopes the 8 000-token NFR to "the assembled prompt" and budgets repair
reprompts as a separate line — so this is a gap in what the spec constrains, not
a breach of it. Worth noting that AC-65's empty-content case is precisely the
one that triggers two repairs, so the attempts that exceed the budget are the
ones most likely to occur in practice.
