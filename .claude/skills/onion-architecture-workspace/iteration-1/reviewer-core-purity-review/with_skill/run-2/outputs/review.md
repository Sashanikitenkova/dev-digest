# PR review — `reviewer-core/src/review/summarize.ts` (second-pass summariser)

**Verdict: request changes.** The file is not mergeable as written. It breaks three of `reviewer-core`'s
load-bearing invariants at once (purity, injected-`LLMProvider`, mandatory grounding), and separately it
does not compile against the current `assemblePrompt` / `StructuredRequest` signatures — so it has almost
certainly never been run.

Reviewed against `.claude/skills/onion-architecture/SKILL.md` and
`guides/reviewer-core-llm-port.md`, `guides/layer-model.md`, `guides/pitfalls-and-tradeoffs.md`, plus
`reviewer-core/CLAUDE.md` and `reviewer-core/INSIGHTS.md`.

---

## Critical

### 1. The mandatory grounding gate is bypassed — hallucinated line citations reach the PR page
**`summarize.ts:55–66`** (`const result = await llm.completeStructured(...)` → `findings: result.data.findings`)

`result.data.findings` is returned to the caller exactly as the model emitted it. Nothing calls
`groundFindings()`. This is the single non-negotiable domain invariant in this package:

- `reviewer-core/CLAUDE.md`: *"Grounding is mandatory — never bypass `groundFindings()` or trust the
  model's self-reported score."*
- `guides/reviewer-core-llm-port.md` names this exact anti-pattern: *"Bad: a new caller … reading
  `StructuredResult.data.findings` directly off the `LLMProvider` response and persisting them without
  routing through `groundFindings()`."*
- `review/run.ts:216` is the reference implementation — `groundFindings(merged.findings, input.diff)`
  is unconditional and shared by both strategies, and the returned `dropped[]` exists so a drop is
  never silent.

It is worse here than in the general case: the doc comment says these findings are *"worth surfacing
above the fold on the PR page"*, so an ungrounded finding gets the most prominent slot in the UI.

**Do this:** either (a) run the output through `groundFindings(findings, input.diff)` and surface
`kept` plus a `dropped` list on `SummarizeOutcome`, mirroring `ReviewOutcome.dropped`; or, better,
(b) don't let the second pass mint findings at all — pass in the already-grounded `Finding[]` from
`reviewPullRequest` and have this pass only *select and rank* from that set by id. Option (b) removes
the failure mode by construction and is what the doc comment ("*the findings worth surfacing*")
actually describes.

### 2. Filesystem I/O inside `reviewer-core` — package purity broken, and an unchecked arbitrary-file read
**`summarize.ts:1`** (`import { readFile } from 'node:fs/promises'`), **`:19–20`** (`skillPaths?: string[]`),
**`:43–46`** (the `readFile(path, 'utf8')` loop)

`reviewer-core` has zero filesystem access by design. `reviewer-core/src/index.ts` states it: *"NO
database, GitHub, or filesystem access; the only side effect is an LLM call through an INJECTED
LLMProvider."* `grep -rn "node:fs" reviewer-core/src` currently returns nothing — this import would be
the first. The SKILL's Quick Reference covers precisely this case: *"Give `reviewer-core` a new
capability that needs a DB row or a file read → Resolve it to a plain string/object in the caller
(`server`), pass it in as data."* `ReviewInput.skills` (`run.ts:56`) already models the correct shape:
*"Resolved skill bodies (NOT slugs)."*

There is a security dimension on top of the layering one. `skillPaths` is documented as *"Absolute
paths"* and is read with no containment check whatsoever. The server deliberately keeps that gate on
its own side of the boundary — `server/src/modules/context/helpers.ts:53` (`safeContextPath`,
delegating to `safeRepoRelativePath`), whose comment explains it must be *"unit-testable on its own,
without a clone or a database"*, and `prompt.ts:96–98` records why reviewer-core can't do it:
*"Already containment-checked by the caller … reviewer-core does no I/O and therefore cannot validate
it itself."* Moving the read here relocates a security boundary into the one package that structurally
cannot enforce it.

Also note the loop is sequential `await` inside `for` — but fix the design, not the concurrency.

**Do this:** delete the `node:fs/promises` import and the loop. Replace `skillPaths?: string[]` with
resolved bodies supplied by the caller (see finding #6 for the right type). The server resolves them
from Postgres, the CI runner from the filesystem — that split already exists and works.

### 3. A concrete adapter is constructed inside the domain core, and the API key is read from `process.env`
**`summarize.ts:5`** (`import { OpenRouterProvider } from '../llm/openrouter.js'`),
**`:39–41`** (`process.env.OPENROUTER_API_KEY` → `new OpenRouterProvider(key, …)`)

This is the textbook violation the skill calls out by name. `guides/reviewer-core-llm-port.md`:
*"When reviewing `reviewer-core` code, don't flag `llm/openrouter.ts` itself as a boundary violation —
flag any **other** file in the package that starts constructing providers or reading API keys
directly."* And: *"Bad: `review/run.ts` or `prompt.ts` … constructing an `OpenRouterProvider` /
reading `process.env.OPENROUTER_API_KEY` internally instead of receiving `llm` as a parameter."*

Two separate rules are broken:

- **Composition root.** `OpenRouterProvider` is constructed in exactly one place per consumer —
  `server/src/platform/container.ts:193` (`buildLlm`) for the studio, and the CI runner's own root.
  `guides/layer-model.md` is explicit that `reviewer-core` has *two* composition roots and *"must stay
  agnostic to both"*. Hardcoding OpenRouter here makes the summariser unusable from any consumer wired
  to `OpenAIProvider` or `AnthropicProvider`, and unmockable in tests — `reviewer-core`'s whole test
  suite is *"hermetic, stubbed `LLMProvider`"* (`reviewer-core/CLAUDE.md`).
- **Secrets.** Root `CLAUDE.md`: *"Secrets (LLM/GitHub keys) live in `~/.devdigest/secrets.json`
  (mode 0600), never `.env`/DB."* The key comes from `SecretsProvider` (`container.ts:191`,
  `await this.secrets.get('OPENROUTER_API_KEY')`). Reading `process.env` here bypasses that provider
  entirely and would simply be `undefined` in the studio, so the function throws at line 40 on every
  call in the deployment it is presumably meant for.

Side effect of the same construction: `container.ts:193–196` injects `estimateCost` from the live
`PriceBook`. This call site passes only `timeoutMs`, so cost attribution for the second pass is lost
even if it otherwise worked.

**Do this:** add `llm: LLMProvider` to `SummarizeInput` (mirroring `ReviewInput.llm`, `run.ts:53`),
delete lines 5 and 39–41, and let each consumer's composition root pass the provider it already built.

---

## High

### 4. Does not compile — `completeStructured` is called with a request shape that doesn't exist
**`summarize.ts:55–60`**

`StructuredRequest<T>` (`server/src/vendor/shared/adapters.ts:55–70`) is
`{ model, schema, schemaName, messages, temperature?, maxTokens?, timeoutMs?, maxRetries?, sessionId? }`.
There are no `system` or `user` fields, and the two **required** fields `messages` and `schemaName` are
both missing. `OpenRouterProvider.completeStructured` dereferences both unconditionally
(`openrouter.ts:60` `toJsonSchema(req.schema, req.schemaName)`, `:62` `[...req.messages]`), so even
past the type error this throws on `req.messages` being `undefined`.

**Do this:** follow `run.ts:193–200` — `messages: a.messages`, `schemaName: 'ReviewSummary'`, and pass
`maxRetries` through.

### 5. `assemblePrompt` is called with the wrong parts and its return value is destructured wrongly
**`summarize.ts:48–53`** (the call) and **`:57–58`** (`prompt.system` / `prompt.user`)

Three mismatches against `prompt.ts:200–257`:

- `PromptParts` has **`system`**, not `systemPrompt` (`prompt.ts:202`). `systemPrompt` is `ReviewInput`'s
  field name (`run.ts:47`); `run.ts:149` maps it across (`system: input.systemPrompt`).
- `PromptParts.diff` is a **`string`** — `run.ts:161` passes `input.diff.raw`, and `prompt.ts:295` does
  `wrapUntrusted('diff', parts.diff)` on it. Passing the `UnifiedDiff` object here would stringify to
  `[object Object]` if the types didn't already reject it.
- `assemblePrompt` returns `AssembledPrompt` = `{ messages, assembly }` (`prompt.ts:299–316`). There is
  no `.system` / `.user` on it; `system` and `user` are locals folded into `messages` and into
  `assembly`.

A consequence worth fixing deliberately, not just incidentally: the discarded `assembly` is what the
run trace persists (`ReviewOutcome.assembly`, `run.ts:123`; `run-executor.ts` writes it as
`prompt_assembly`). As written, the second LLM call would be invisible in the Run Trace drawer.

**Do this:** `assemblePrompt({ system: input.systemPrompt, diff: input.diff.raw, skills, task: input.task })`,
then use `.messages`, and surface `.assembly` on `SummarizeOutcome` so the trace shows both passes.

### 6. Raw skill file bodies are injected as trusted instructions — prompt-injection hole
**`summarize.ts:43–46`** (bodies pushed verbatim) → **`:51`** (`skills`)

Whatever lands in the `skills` slot is joined into the user message as-is (`prompt.ts:260–261`,
`:284`). The trust decision is made by `formatSkillBlocks` (`prompt.ts:76–82`): `trusted` → plain
`### name\nbody`; anything else → `wrapUntrusted('skill:<name>', body)`, which is what brings it under
`INJECTION_GUARD`. This file skips that entirely, so every skill body — including imported/community
ones — is handed to the model in instruction position.

`reviewer-core/INSIGHTS.md` (2026-07-19) records this as a decision, not an accident: the rule lives in
`reviewer-core` so the studio and the CI runner can't diverge, and *"the divergence would be a
prompt-injection hole rather than a cosmetic bug."* `run-executor.ts:453–459` shows the caller-side
half (`trusted: l.skill.source === 'manual'`).

**Do this:** take `skills?: string[]` already-formatted by `formatSkillBlocks` (as `ReviewInput` does),
or take `SkillBlock[]` and call `formatSkillBlocks` here. Either way the `trusted` flag must be an
explicit input, never assumed.

### 7. `z.custom<Finding>()` validates nothing at runtime and breaks strict JSON-schema mode
**`summarize.ts:3`** (type-only import) and **`:9–12`** (`findings: z.array(z.custom<Finding>())`)

`Finding` in `@devdigest/shared` is a **Zod schema value**, not just a type
(`server/src/vendor/shared/contracts/findings.ts:46`), and it is documented as the single source of
truth for *"LLM structured output (`response_format` / forced tool-use)"*. Two concrete failures from
substituting `z.custom`:

- **No validation.** `z.custom<T>()` with no validator accepts literally anything. `parseWithRepair`
  (`structured.ts:52`) is the package's only runtime guard on model output; with `z.custom` it will
  happily return `findings: [null, "oops"]` typed as `Finding[]`, and the repair loop will never fire.
  Downstream code that reads `f.severity` / `f.start_line` (e.g. `to-review.ts:39`, `grounding.ts:73`)
  then breaks far from the cause.
- **Invalid request schema.** `toJsonSchema` (`structured.ts:19`) runs `zodResponseFormat`, and the
  provider sends it with `strict: true` (`openrouter.ts:81`). A `z.custom` node produces an untyped
  `{}` property, which OpenAI-compatible strict `json_schema` mode rejects — a 400 on every call.

**Do this:** `import { Finding } from '@devdigest/shared'` as a value and use `z.array(Finding)`. Give
the payload a named export (e.g. `export const SummaryPayload = …`) so tests can exercise it, and pass
a real `schemaName` for the repair messages to reference.

---

## Medium

### 8. The model is hardcoded inside the domain core
**`summarize.ts:7`** (`const SUMMARY_MODEL = 'anthropic/claude-3.5-haiku'`), used at **`:56`** and **`:65`**

Model choice is caller policy everywhere else in this package: `ReviewInput.model` (`run.ts:48`) is a
required input, described as *"Model id understood by the injected provider."* A literal OpenRouter-namespaced
id (`anthropic/…`) baked into the engine ties the second pass to one provider's id namespace — the same
coupling finding #3 creates for the client — and it silently ignores whatever model the agent is
configured with. It is also unreachable from the settings/agent model pickers, so nobody can change it
without a code change and a release.

Related: the repo's pricing table keys this family as `claude-3-5-haiku-latest`
(`server/src/adapters/llm/pricing.ts:25`), so even with `estimateCost` wired the id here wouldn't
resolve to a price.

**Do this:** add `model: string` to `SummarizeInput`. Keep a `DEFAULT_SUMMARY_MODEL` export if a
default is genuinely wanted, following the `DEFAULT_MAP_THRESHOLD_LINES` precedent (`run.ts:31`) — an
exported default the caller may override, not a hidden constant.

### 9. The outcome drops every cross-cutting concern `ReviewOutcome` carries
**`summarize.ts:25–29`** (`SummarizeOutcome`) and **`:55–60`** (the call)

Compared with `ReviewOutcome` (`run.ts:108–131`), this returns no `tokensIn`/`tokensOut`/`costUsd`, no
`raw`, no `assembly`, and accepts no `sessionId`, `onEvent`, or `checkCancelled`. Practical
consequences, each of which someone will file as a bug later:

- **`sessionId`** — `run.ts:97` exists so *"all chunks of this review group into one session in the
  OpenRouter dashboard"* (`openrouter.ts:85` only forwards it when present). The summary call would sit
  outside its own review's session.
- **Tokens/cost** — the run trace's `tokens_in` / `tokens_out` / `cost_usd`
  (`run-executor.ts:336–338`) would under-report every review by one whole LLM call.
- **`checkCancelled`** — `run.ts:183` checkpoints before each expensive call; a cancelled run would
  still pay for the summary pass.
- **`onEvent`** — no SSE progress for a user-visible second pass.

**Do this:** mirror the `ReviewOutcome` fields and thread `sessionId` / `onEvent` / `checkCancelled`
through, or state in the doc comment why this pass is deliberately exempt from each.

---

## Low

### 10. Not exported from the package's public surface
**`summarize.ts:38`** (`export async function summarizeReview`), missing from `reviewer-core/src/index.ts`

`server/tsconfig.json:24` aliases `@devdigest/reviewer-core` → `src/index.ts`, and every engine
capability is re-exported there with a section comment (`index.ts:54–64` for `reviewPullRequest`). A
consumer would have to deep-import via the `/*` alias, which no in-repo caller currently does.

**Do this:** add `summarizeReview` plus `SummarizeInput` / `SummarizeOutcome` to `index.ts`.

### 11. No tests
`reviewer-core/test/` holds seven suites, all hermetic against a stubbed `LLMProvider`
(`reviewer-core/CLAUDE.md`). A new engine entry point ships with none. Note that the current design is
*untestable* — with the provider constructed internally from `process.env`, there is no seam. Once
finding #3 is fixed, add `test/summarize.test.ts` covering at minimum: an ungrounded finding is dropped
(#1), skill bodies marked untrusted are delimiter-wrapped (#6), and a malformed `findings` payload is
rejected by the schema rather than passed through (#7). Also worth knowing while writing it:
`typecheck` does **not** cover `test/**` (`reviewer-core/INSIGHTS.md`, 2026-08-11).

---

## Checked and clean

- **File placement.** `src/review/summarize.ts` beside `run.ts` / `reduce.ts` is the right home for a
  review-pipeline stage; no new top-level file, no new package.
- **`../llm/openrouter.js` is not itself the problem.** Per `guides/reviewer-core-llm-port.md`, that
  adapter living inside `reviewer-core` is a documented, deliberate exception. Finding #3 is about this
  file *constructing* it, not about the adapter's location.
- **Second pass as a concept.** Nothing in the layering forbids a second LLM pass; `reviewPullRequest`
  already makes N calls on the map-reduce path. The problems here are all in how it is wired, not in
  the idea.
- **Not flagged, per `guides/pitfalls-and-tradeoffs.md`:** whole-`Container` injection into services and
  row-types-as-DTOs are documented intentional compromises and are irrelevant to this file anyway.

---

## Suggested shape after the fixes

```ts
export interface SummarizeInput {
  systemPrompt: string;
  model: string;                 // #8 — caller policy
  diff: UnifiedDiff;
  llm: LLMProvider;              // #3 — injected, never constructed
  skills?: string[];             // #2/#6 — resolved + trust-formatted by the caller
  task?: string;
  sessionId?: string;            // #9
  onEvent?: (e: ReviewEvent) => void;
  checkCancelled?: () => void;
}
```

…with the body assembling via `assemblePrompt({ system, diff: input.diff.raw, skills, task })`, calling
`input.llm.completeStructured({ model, schema, schemaName, messages, maxRetries, ...sessionId })`, and
piping the result through `groundFindings(…, input.diff)` before it returns. At that point the file has
no imports outside `@devdigest/shared` and its own pure siblings — which is the actual test for whether
it belongs in this package.
