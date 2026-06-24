# CLAUDE.md — reviewer-core (`@devdigest/reviewer-core`)

Pure review engine: diff → prompt → LLM → grounded findings. No DB, GitHub, or
filesystem — the only side effect is an LLM call through an injected
`LLMProvider`. Consumed as TypeScript source by `server` via a tsconfig path
alias. See root [`CLAUDE.md`](../CLAUDE.md) for cross-package conventions.

## Stack

Pure TypeScript, `openai` SDK (used generically, incl. for OpenRouter), Zod.

## Commands

`npm test` (vitest, hermetic, stubbed `LLMProvider`) ·
`npm run typecheck` — **this is the build**; the package never emits JS.

## Map

`prompt.ts` — `assemblePrompt()` / `wrapUntrusted()` / `INJECTION_GUARD`.
`grounding.ts` — `groundFindings()`, the mandatory citation gate.
`llm/openrouter.ts`, `llm/structured.ts` — provider + Zod→JSON-Schema parsing.
`review/run.ts` — single-pass orchestration; `review/reduce.ts` — map-reduce
path (used from L06). `output/to-review.ts` — CI payload helper.

## Non-default conventions

- Never add a real `build` step (emitting `dist/`) without also updating the
  consumer's tsconfig path alias — the whole point is zero-build source reuse.
- Optional prompt slots (`skills`, `memory`, `specs`, `callers`) are accepted
  but unused by the starter server — don't assume they're wired just because
  the function signature accepts them.

## Gotchas

Grounding is mandatory — never bypass `groundFindings()` or trust the model's
self-reported score; the score is always recomputed from surviving findings.

## Read when…

| Doc | Read when |
|---|---|
| [`README.md`](README.md) | the full diff→prompt→LLM→findings pipeline diagram |
| [`docs/README.md`](docs/README.md) | digging into a specific subsystem — currently a stub |
| [`specs/README.md`](specs/README.md) | implementing a feature — currently a stub |
| [`INSIGHTS.md`](INSIGHTS.md) | before changing a long-standing convention, or something behaves surprisingly |
