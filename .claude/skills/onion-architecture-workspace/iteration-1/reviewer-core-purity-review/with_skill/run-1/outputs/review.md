# Review — `reviewer-core/src/review/summarize.ts` (second-pass summariser)

**Verdict: request changes.** The feature is reasonable, but as written this file breaks
`reviewer-core`'s core purity guarantee in three separate ways, skips the mandatory
grounding gate, and does not compile against the real `assemblePrompt` / `LLMProvider`
signatures. Line numbers refer to the proposed file as given.

Reference material: `.claude/skills/onion-architecture/SKILL.md`,
`guides/reviewer-core-llm-port.md`, `guides/layer-model.md`,
`guides/pitfalls-and-tradeoffs.md`, plus `reviewer-core/CLAUDE.md` and
`reviewer-core/INSIGHTS.md`.

---

## Critical

### 1. The core constructs its own LLM provider and reads an API key from the environment
`summarize.ts:5`, `summarize.ts:39-41`

```ts
import { OpenRouterProvider } from '../llm/openrouter.js';
...
const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error('OPENROUTER_API_KEY is not configured');
const llm = new OpenRouterProvider(key, { timeoutMs: 60_000 });
```

This is the exact violation the skill's `reviewer-core-llm-port.md` names as the "bad"
case: `llm/openrouter.ts` is allowed to live inside the package, but it may only be
**constructed at a consumer's composition root** — `server/src/platform/container.ts`'s
`buildLlm()` (lines 187-196) or the CI runner. Every other file receives an
already-constructed `LLMProvider` as a parameter (`reviewer-core/src/review/run.ts:51`,
`ReviewInput.llm`). Today no file under `reviewer-core/src` references `process.env` at
all — a grep returns zero hits; this PR would be the first.

Three concrete consequences beyond the layering breach:
- **Secrets convention broken.** Root `CLAUDE.md`: keys live in `~/.devdigest/secrets.json`
  (mode 0600), never `.env`/DB. The server reads them through `SecretsProvider`
  (`container.ts:191`, `await this.secrets.get('OPENROUTER_API_KEY')`). An env read
  bypasses that entirely and will simply fail in the studio, where the variable is not set.
- **Cost attribution is lost.** `container.ts:193-196` injects `estimateCost` from the
  live `PriceBook`; constructing the provider here without it makes `costUsd` null for
  every summariser call.
- **Untestable.** `reviewer-core`'s suite is hermetic with a stubbed `LLMProvider`
  (`reviewer-core/test/run.test.ts`). A function that `new`s a real provider cannot be
  unit-tested without network or env stubbing.

**Do:** add `llm: LLMProvider` (and `model: string`, see #7) to `SummarizeInput`; delete
the `OpenRouterProvider` import and the `process.env` read; let each composition root pass
the provider in, exactly as `reviewPullRequest` does.

### 2. Filesystem I/O inside a package defined as filesystem-free
`summarize.ts:1`, `summarize.ts:19-20`, `summarize.ts:43-46`

```ts
import { readFile } from 'node:fs/promises';
...
for (const path of input.skillPaths ?? []) {
  skills.push(await readFile(path, 'utf8'));
}
```

`reviewer-core/src/index.ts`'s header and `reviewer-core/CLAUDE.md` both state it plainly:
"NO database, GitHub, or filesystem access; the only side effect is an LLM call through an
INJECTED LLMProvider." `ReviewInput.skills` is documented as "Resolved skill bodies (NOT
slugs)" precisely because the *caller* owns resolution — the studio reads them from
Postgres, the CI runner from disk. There is no `node:fs` import anywhere in
`reviewer-core/src` today.

There is a security dimension too: `skillPaths` are absolute paths arriving as input, read
with no containment check. `prompt.ts:96-98` documents the reason this must not happen here
— "Already containment-checked by the caller (`safeContextPath` in the server);
reviewer-core does no I/O and therefore cannot validate it itself."

**Do:** drop the `node:fs/promises` import and `skillPaths`; accept resolved bodies
(`skills?: SkillBlock[]`, see #5) and have the caller read the files.

### 3. The mandatory citation-grounding gate is bypassed
`summarize.ts:55-66`

```ts
const result = await llm.completeStructured({ ... });
return { headline: result.data.headline, findings: result.data.findings, model: SUMMARY_MODEL };
```

Raw model findings are returned and will be surfaced "above the fold on the PR page" without
ever passing through `groundFindings()`. This is the domain invariant the skill calls
non-negotiable ("Never bypass `groundFindings()` for diff-anchored findings — it's a domain
invariant, not an optional step"), restated in `reviewer-core/CLAUDE.md` and implemented
unconditionally in `review/run.ts:216`. Root `CLAUDE.md` repeats it: "every finding must
cite a real diff line or it's dropped." The most visible surface in the product would become
the one place hallucinated line citations can reach a user.

**Do:** pipe through the gate and report what it dropped, mirroring `run.ts:216-221`:

```ts
const ground = groundFindings(result.data.findings, input.diff);
return { headline: result.data.headline, findings: ground.kept,
         dropped: ground.dropped, grounding: groundingSummary(ground), ... };
```

Worth questioning the design first, though: a *summariser* arguably should not mint new
findings at all. Passing in the already-grounded findings from the review pass and asking
the model only to select/rank them (returning ids, validated against the input set) removes
this whole class of risk and is cheaper.

---

## High

### 4. The file does not compile — three mismatches against the real APIs
`summarize.ts:48-60`

- **`assemblePrompt` takes `diff: string`, not `UnifiedDiff`.** `PromptParts.diff` is
  declared `string` (`reviewer-core/src/prompt.ts:242`) and is rendered via
  `wrapUntrusted('diff', parts.diff)` (`prompt.ts:295`). `run.ts:161` passes
  `input.diff.raw`. Passing the object is a type error, and if it were erased at runtime the
  model would receive `[object Object]` — a summariser reviewing nothing.
- **`assemblePrompt` returns `{ messages, assembly }`, not `{ system, user }`**
  (`prompt.ts:247-250`). `prompt.system` / `prompt.user` on lines 57-58 do not exist.
- **`completeStructured` takes a `StructuredRequest`** —
  `{ model, schema, schemaName, messages, temperature?, maxTokens?, timeoutMs?, maxRetries?,
  sessionId? }` (`server/src/vendor/shared/adapters.ts:55-70`). There are no `system` /
  `user` fields, and `schemaName` is **required** — `openrouter.ts:60` feeds it to
  `toJsonSchema(req.schema, req.schemaName)`.

**Do:** copy the shape from `run.ts:191-199` — `assemblePrompt({ ...parts, diff: input.diff.raw })`,
then `llm.completeStructured({ model, schema, schemaName: 'ReviewSummary', messages: a.messages, maxRetries, sessionId })`.
Please also confirm `npm run typecheck` in `reviewer-core/` passes before re-requesting review;
that command *is* the build for this package.

### 5. Skill bodies are injected as trusted instructions, dropping the shared trust rule
`summarize.ts:43-46` feeding `summarize.ts:51`

Raw file contents go straight into `assemblePrompt`'s `skills` slot, which is joined verbatim
under `## Skills / rules` (`prompt.ts:260-261`, `284`). The repo has one rule for this:
`formatSkillBlocks()` renders `source: 'manual'` skills as plain instructions and everything
else inside `wrapUntrusted('skill:<name>', body)`. `reviewer-core/INSIGHTS.md` (2026-07-19)
records why it lives in the core rather than the server: "Implementing it on the server side
would let the two silently diverge, and the divergence would be a prompt-injection hole
rather than a cosmetic bug." A file path carries no trust flag, so this path can only ever
get the trust decision wrong.

**Do:** accept `skills?: SkillBlock[]` (name/body/trusted) and pass
`formatSkillBlocks(input.skills)` into the prompt, as `server/src/modules/reviews/run-executor.ts:454`
does.

### 6. `z.custom<Finding>()` turns off validation on the model's output
`summarize.ts:9-12`

```ts
findings: z.array(z.custom<Finding>()),
```

`z.custom` with no validator function accepts **any** value — it is a compile-time cast, not
a runtime check. `Finding` is a real Zod schema exported as a *value* from
`@devdigest/shared` (`server/src/vendor/shared/contracts/findings.ts:47`), and the file
imports it `import type`, so the runtime schema is discarded. Two failures follow:
`toJsonSchema` cannot emit a meaningful item schema, so the model is never told the
`Finding` shape; and `parseWithRepair` cannot detect a malformed finding, so garbage flows
downstream (including into `groundFindings`, which reads `start_line`/`end_line`).

**Do:** import `Finding` as a value and use `z.array(Finding)` — or reuse the existing
`Review` contract if the payload is close enough.

---

## Medium

### 7. Model and timeout are hardcoded in the core
`summarize.ts:7`, `summarize.ts:41`

`const SUMMARY_MODEL = 'anthropic/claude-3.5-haiku'` pins both a model and, implicitly, the
OpenRouter naming scheme — the string is not valid for the `openai` or `anthropic`
providers the `Container` can also return. Everywhere else the model is caller-chosen:
`ReviewInput.model` in the engine, and `resolveFeatureModel(container, workspaceId, 'risk_brief')`
in `server/src/modules/brief/service.ts:235-241` for the equivalent feature. Hardcoding it
here means a user's model setting silently doesn't apply to this pass and no one can swap
the model without a code change.

**Do:** take `model: string` on `SummarizeInput`; let the server resolve it via the feature
model settings and CI pass its own. Keep timeout/temperature/maxTokens as per-request
`StructuredRequest` fields (as `brief/service.ts:240-246` does), not baked into a
constructor.

### 8. Not exported from the package's public surface
`reviewer-core/src/index.ts`

`index.ts` is the package's API — consumers import through the `@devdigest/reviewer-core`
path alias, and every entry point is re-exported there with its types. `summarizeReview`
isn't, so neither the server nor the runner can reach it.

**Do:** add `export { summarizeReview, type SummarizeInput, type SummarizeOutcome } from './review/summarize.js';`
alongside the `reviewPullRequest` block.

### 9. Usage, cost and session telemetry are dropped
`summarize.ts:55-66`

`StructuredResult` carries `tokensIn`, `tokensOut`, `costUsd`, `raw`, `attempts`
(`adapters.ts:72-80`); `run.ts:203-208` accumulates all of them into the run trace. This
function discards every one. It also forwards no `sessionId`, so the summariser call will not
group with its review in the OpenRouter dashboard — the stated reason that field exists
(`adapters.ts:64-69`).

**Do:** accept `sessionId?: string`, forward it, and return the token/cost figures in
`SummarizeOutcome`. Minor, same area: line 65 returns the `SUMMARY_MODEL` constant rather
than `result.model`, so a provider-side model resolution or fallback won't be visible in the
trace.

### 10. No tests
`reviewer-core/test/`

A new engine entry point should land with a hermetic vitest spec alongside `run.test.ts` —
stubbed `LLMProvider`, asserting at minimum that ungrounded findings are dropped, that
untrusted skills are delimiter-wrapped, and that the caller's model is used. This becomes
possible only once #1 is fixed; that dependency is itself the signal the skill describes
("a 'unit' test that needs a live DB — or here, a live key — is a signal a boundary leaked").

---

## Low / discussion

### 11. Is `reviewer-core` the right home at all?
`summarize.ts` (whole file)

A PR-summarising second pass already exists as a full server module —
`server/src/modules/brief/` (`service.ts` + `prompt.ts` + `budget.ts` + `helpers.ts`),
which resolves its model through settings, calls `container.llm(...)`, and enforces a token
budget. If this pass is only ever orchestrated by the studio, it likely belongs there and can
reuse that machinery. `reviewer-core` earns a capability when **both** consumers need it —
the studio and the CI runner (`guides/layer-model.md`, "two composition roots"). Please state
in the PR description which consumers need this; if it is only the server, moving it avoids
duplicating brief-style logic in two places.

### 12. Prompt budget
`summarize.ts:48-53`

The whole diff plus all skill bodies are re-sent for the summary pass with no truncation or
budget check, unlike the review path (map-reduce above `DEFAULT_MAP_THRESHOLD_LINES`) and
the brief path (`assertWithinBudget`). On a large PR this pass will be the one that blows the
context window. Worth deciding deliberately: summarise from the *findings* rather than
re-sending the diff, or apply a budget.

---

## Suggested shape after the fixes

```ts
export interface SummarizeInput {
  systemPrompt: string;
  model: string;                 // caller-chosen (#7)
  llm: LLMProvider;              // injected, never constructed (#1)
  diff: UnifiedDiff;
  skills?: SkillBlock[];         // resolved bodies + trust flag (#2, #5)
  task?: string;
  sessionId?: string;            // (#9)
}
```
with the body assembling via `assemblePrompt({ ..., skills: formatSkillBlocks(skills), diff: input.diff.raw })`,
calling `llm.completeStructured({ model, schema, schemaName, messages })`, and returning
`groundFindings(...).kept` plus the dropped list and usage.

## What I checked and found clean

- The `Finding` / `UnifiedDiff` type imports from `@devdigest/shared` are the right source.
- Placing the file under `reviewer-core/src/review/` alongside `run.ts` / `reduce.ts` matches
  the package map in `reviewer-core/CLAUDE.md` (assuming #11 resolves in favour of the core).
- Reusing `assemblePrompt` rather than hand-rolling a prompt is correct — it is what applies
  `INJECTION_GUARD` and `OUTPUT_LANGUAGE` on every path.
- The doc comment explaining *why* the second pass exists is in this repo's house style.
- Per the skill's pitfalls guide, I have **not** flagged this repo's documented, intentional
  compromises (whole-`Container` injection into services; row types doubling as DTOs), nor
  `llm/openrouter.ts` living inside the "pure" package — that exception is deliberate. What
  is flagged in #1 is a *different* file constructing the provider, which the same guide
  names explicitly as the violation to look for.
