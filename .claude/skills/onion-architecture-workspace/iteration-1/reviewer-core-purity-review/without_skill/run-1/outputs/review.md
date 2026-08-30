# PR review — `reviewer-core/src/review/summarize.ts` (second-pass summariser)

**Verdict: request changes — do not merge.**

The feature idea is fine (a second pass that answers "what should a reader know
first" is a reasonable addition next to `reviewPullRequest`). The implementation,
however, breaks the single invariant that defines this package — `reviewer-core`
is pure, does no I/O, and takes its LLM as an injected port — and it also
bypasses the mandatory citation-grounding gate. As written it does not compile,
and if it did compile it would return unvalidated model output straight to the
UI.

Reference points used below:
- `/Users/olexandra/Documents/dev-digest/reviewer-core/CLAUDE.md`
- `/Users/olexandra/Documents/dev-digest/reviewer-core/src/index.ts` (package docstring)
- `/Users/olexandra/Documents/dev-digest/reviewer-core/src/review/run.ts` (the sibling entry point this should mirror)
- `/Users/olexandra/Documents/dev-digest/server/src/platform/container.ts` (the composition root)
- `/Users/olexandra/Documents/dev-digest/server/src/vendor/shared/adapters.ts` (the `LLMProvider` / `StructuredRequest` port)

---

## Blocking

### 1. Filesystem I/O inside the pure engine — `summarize.ts:1`, `:44-46`

```ts
import { readFile } from 'node:fs/promises';
...
for (const path of input.skillPaths ?? []) {
  skills.push(await readFile(path, 'utf8'));
}
```

`reviewer-core/CLAUDE.md` opens with "No DB, GitHub, or filesystem — the only
side effect is an LLM call through an injected `LLMProvider`", and
`src/index.ts:5-6` repeats it. Today `reviewer-core/src` contains **zero**
`node:fs` imports and **zero** `process.env` reads; this PR would be the first
breach of both. The package is also bundled into the CI runner via `@vercel/ncc`
and consumed as raw source by the server — pulling a Node built-in in makes the
engine non-portable and un-mockable.

`ReviewInput.skills` is documented as "Resolved skill bodies (NOT slugs)"
(`run.ts:57`) precisely because resolution is the caller's job: the studio reads
them from Postgres, the CI runner from disk.

**Fix:** delete the `node:fs/promises` import and the `skillPaths` field. Accept
`skills?: string[]` (already-resolved bodies), exactly like `ReviewInput`. The
server resolves them in `server/src/modules/reviews/run-executor.ts:436`
(`buildSkillBlocks`); the runner does it on its side.

### 2. The engine constructs its own adapter and reads a secret from `process.env` — `summarize.ts:5`, `:39-41`

```ts
const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error('OPENROUTER_API_KEY is not configured');
const llm = new OpenRouterProvider(key, { timeoutMs: 60_000 });
```

Three separate violations in three lines:

- **Adapter constructed outside the composition root.** Every `LLMProvider` in
  this repo is built in `server/src/platform/container.ts:180-201` and injected.
  `reviewPullRequest` takes `llm: LLMProvider` (`run.ts:53`) and never names a
  concrete provider. Hard-wiring `OpenRouterProvider` here means the summariser
  can never run against OpenAI or Anthropic, and can never be stubbed in a test.
- **Secret read from the environment.** Root `CLAUDE.md` is explicit: "Secrets
  (LLM/GitHub keys) live in `~/.devdigest/secrets.json` (mode 0600), never
  `.env`/DB." The container reads it through the `secrets` port
  (`container.ts:191`) and throws a typed `ConfigError`. This code will simply
  find `undefined` in the studio, where the key is *not* in the environment, and
  fail at runtime with a generic `Error` that the API's error mapper will
  surface as a 500 rather than a configuration problem.
- **Cost attribution silently lost.** The container injects `estimateCost` from
  the live `PriceBook` (`container.ts:194-196`). A bare
  `new OpenRouterProvider(key)` has no estimator, so every summariser call
  reports `costUsd: null` unless OpenRouter happens to return `usage.cost`.

**Fix:** add `llm: LLMProvider` and `model: string` to `SummarizeInput`, delete
lines 39-41 and the `OpenRouterProvider` import, and let the caller pass the
provider the container already resolved.

### 3. The mandatory citation-grounding gate is bypassed — `summarize.ts:62-66`

```ts
return {
  headline: result.data.headline,
  findings: result.data.findings,   // straight from the model
  model: SUMMARY_MODEL,
};
```

Root `CLAUDE.md`: "Review grounding is mandatory across the pipeline — every
finding must cite a real diff line or it's dropped."
`reviewer-core/CLAUDE.md`: "Grounding is mandatory — never bypass
`groundFindings()`." `run.ts:216` applies it unconditionally and treats it as
"the only post-step; not duplicated per strategy".

This function receives `input.diff` (a `UnifiedDiff`) and therefore has
everything `groundFindings` needs — it just doesn't call it. Any finding this
second pass invents, or any line number it re-derives incorrectly from the
first pass, will be rendered "above the fold on the PR page" with a citation
that points nowhere.

**Fix:**

```ts
import { groundFindings, groundingSummary } from '../grounding.js';
...
const ground = groundFindings(result.data.findings, input.diff);
return {
  headline: result.data.headline,
  findings: ground.kept,
  dropped: ground.dropped,          // "never go silent" — see ReviewOutcome.dropped
  grounding: groundingSummary(ground),
  model: input.model,
};
```

Also consider whether the summariser should be allowed to *mint* findings at
all. A cheaper and safer contract is to have it return **ids** selected from the
already-grounded first-pass findings; then grounding cannot be re-broken by
construction. Worth a design decision before merge either way.

### 4. `z.custom<Finding>()` validates nothing and produces an invalid strict schema — `summarize.ts:3`, `:9-12`

```ts
const SummaryPayload = z.object({
  headline: z.string(),
  findings: z.array(z.custom<Finding>()),
});
```

`z.custom()` with no validator is `z.any()` with a TypeScript cast on top. I
verified both halves of this against the package's own `zod` and `openai`:

- Parsing: `SummaryPayload.safeParse({ headline: 'h', findings: [{lol:1}, 42, null] })`
  returns `success: true`. `42` and `null` arrive at the caller typed as
  `Finding`. Every downstream consumer that reads `finding.file` or
  `finding.start_line` — including `groundFindings` once you add it — will throw
  or misbehave on data the type system swore was safe.
- Schema emission: `zodResponseFormat(SummaryPayload, 'SummaryPayload')` emits
  `"findings": { "type": "array" }` with **no `items`**. OpenAI/OpenRouter
  `json_schema` strict mode (`openrouter.ts:79-82` sets `strict: true`) rejects
  an array without `items`, so this call most likely fails at the provider before
  the model ever runs.

**Fix:** import the real schema — `import { Finding } from '@devdigest/shared'`
(it is a Zod object, `server/src/vendor/shared/contracts/findings.ts:47`, and it
is exported as both a value and a type) — and use
`findings: z.array(Finding)`. `run.ts:9` does exactly this with
`Review as ReviewSchema`.

### 5. The call to `completeStructured` does not match the port — `summarize.ts:55-60`

```ts
const result = await llm.completeStructured({
  model: SUMMARY_MODEL,
  system: prompt.system,
  user: prompt.user,
  schema: SummaryPayload,
});
```

`StructuredRequest<T>` (`server/src/vendor/shared/adapters.ts:55-69`) has
**no** `system` or `user` fields, and `schemaName: string` and
`messages: ChatMessage[]` are **required**. This is a compile error, and
`schemaName` is not cosmetic — `openrouter.ts:81` passes it as the
`json_schema.name` and uses it in every error message.

**Fix:** mirror `run.ts:193-200`:

```ts
const res = await input.llm.completeStructured<SummaryPayload>({
  model: input.model,
  schema: SummaryPayload,
  schemaName: 'SummaryPayload',
  messages: a.messages,
  maxRetries: input.maxRetries ?? 2,
  ...(input.sessionId ? { sessionId: input.sessionId } : {}),
});
```

### 6. The call to `assemblePrompt` does not match its signature — `summarize.ts:48-53`

```ts
const prompt = assemblePrompt({
  systemPrompt: input.systemPrompt,   // field is `system`, not `systemPrompt`
  diff: input.diff,                   // PromptParts.diff is `string`, not UnifiedDiff
  skills,
  task: input.task,
});
```

`PromptParts` (`prompt.ts:200-244`) declares `system: string` and
`diff: string`. `AssembledPrompt` (`prompt.ts:247-250`) returns
`{ messages, assembly }` — there is no `prompt.system` / `prompt.user` to read
on line 57-58. Four compile errors in six lines.

Together with #5, this means the PR was never type-checked. `npm run typecheck`
in `reviewer-core/` **is** the build for this package (`package.json` has no
emit step) — it must be green before merge.

**Fix:** pass `system: input.systemPrompt` and `diff: input.diff.raw`
(`run.ts:161` uses `input.diff.raw`), and consume `a.messages`.

### 7. Skill bodies are injected as trusted instructions — `summarize.ts:43-46`, `:51`

Raw file contents are pushed into `skills` and handed straight to
`assemblePrompt`, which joins that slot verbatim (`prompt.ts:281`). The trust
decision for skills lives in `formatSkillBlocks` (`prompt.ts:76`): only
`source: 'manual'` bodies render as instructions; everything else is wrapped in
`wrapUntrusted('skill:<name>', body)` so the shared `INJECTION_GUARD` covers it.
`reviewer-core/INSIGHTS.md` (2026-07-19) records that this rule lives here
specifically so the studio and the CI runner cannot diverge, and that a
divergence is "a prompt-injection hole rather than a cosmetic bug".

Compounding it: `skillPaths` is documented as "Absolute paths" with no
containment check anywhere in this file. An arbitrary absolute path (say
`~/.devdigest/secrets.json`) would be read off disk and shipped to a third-party
LLM endpoint. The server has `safeContextPath`
(`server/src/modules/context/helpers.ts`) as the security boundary for exactly
this, and `prompt.ts:96-98` notes reviewer-core "does no I/O and therefore
cannot validate it itself".

**Fix:** removing the fs read (#1) removes the traversal risk. Then take
`SkillBlock[]` and run it through `formatSkillBlocks`, or take the
already-formatted `string[]` blocks the caller produced.

---

## Should fix before merge

### 8. Hardcoded model — `summarize.ts:7`, `:56`, `:65`

```ts
const SUMMARY_MODEL = 'anthropic/claude-3.5-haiku';
```

Model choice is a caller decision everywhere else in this repo:
`ReviewInput.model` (`run.ts:48`) is required and the container resolves the
provider to match. Pinning a model in the engine means the studio's model
picker, the cost table, and `docs/agent-prompts/choosing-a-model.md` all
disagree with what actually runs. The pinned id is also stale — the model table
in `docs/agent-prompts/choosing-a-model.md:37` lists
`anthropic/claude-haiku-4.5` as the cheap Claude option, not a 3.5-era id.

**Fix:** `model: string` on `SummarizeInput`; return `input.model`. Delete the
constant. (If a default is genuinely wanted, export it as
`DEFAULT_SUMMARY_MODEL` beside `DEFAULT_MAP_THRESHOLD_LINES` so the caller can
see and override it — but a default that names a specific vendor in a
provider-agnostic engine is still a smell.)

### 9. Token, cost and trace accounting are thrown away — `summarize.ts:25-29`, `:62-66`

`SummarizeOutcome` returns only `{ headline, findings, model }`.
`completeStructured` hands back `tokensIn`, `tokensOut`, `costUsd`, `raw` and
`attempts` (`adapters.ts:71-79`), and `ReviewOutcome` (`run.ts:126-131`)
propagates all of them so the run trace and the cost panel stay truthful. A
second LLM call per review that reports nothing makes every displayed cost
figure quietly wrong.

**Fix:** add `tokensIn`, `tokensOut`, `costUsd`, `raw` to `SummarizeOutcome` and
have the caller fold them into the run trace, the way `run-executor.ts` folds in
the intent classifier call as a separate `tool_calls` entry.

### 10. No `sessionId` forwarded — `summarize.ts:55-60`

`run.ts:97` documents `sessionId` as "forwarded on every LLM call so all chunks
of this review group into one session in the OpenRouter dashboard". A
second-pass call that belongs to the same review but omits it will show up as an
orphan generation.

**Fix:** add `sessionId?: string` to `SummarizeInput` and spread it into the
request as `run.ts:199` does.

### 11. No tests, and the code as written is untestable — new file, no `reviewer-core/test/summarize.test.ts`

`TESTING.md:53-54` describes the reviewer-core suite as "the pure engine … with
a stubbed model → grounded findings. No DB / GitHub / FS." Every existing test
(`reviewer-core/test/run.test.ts`) works by passing a fake `LLMProvider`. This
function cannot be tested that way at all — it builds its own provider and needs
a live `OPENROUTER_API_KEY` and real files on disk.

Fixing #1 and #2 makes it testable; then add a `summarize.test.ts` covering at
minimum: a stubbed provider returning a hallucinated finding is dropped by
grounding; skills land in the assembled prompt; token/cost totals propagate.
Note `reviewer-core/INSIGHTS.md` (2026-08-11) — `npm run typecheck` does not
cover `test/**`, so run the suite, don't just type-check.

### 12. Not exported from the package entry point — `reviewer-core/src/index.ts`

`index.ts` re-exports every public surface (`reviewPullRequest`,
`groundFindings`, `formatSkillBlocks`, …). `summarizeReview`,
`SummarizeInput` and `SummarizeOutcome` are absent, so no consumer can import
them through `@devdigest/reviewer-core`. Add them next to the `review/run.js`
block.

---

## Minor

### 13. Sequential `await` inside a loop — `summarize.ts:44-46`

Even once the reads move out of this package, note the pattern: N files read
strictly one after another. Wherever this lands, `await Promise.all(paths.map(...))`.

### 14. Undocumented timeout override — `summarize.ts:41`

`{ timeoutMs: 60_000 }` silently narrows the provider default of `90_000`
(`openrouter.ts:54`) with no comment saying why. If the shorter timeout is
deliberate, say so; otherwise drop it. (Moot once the provider is injected.)

### 15. Doc comment overstates what the pass does — `summarize.ts:31-37`

"It re-reads the same diff" is accurate but undersells the cost: this doubles
the LLM spend per review, and on the map-reduce path the diff may not fit in one
call at all (`run.ts:133-139` exists for exactly that reason). Either document
the size ceiling or reuse the first pass's findings rather than the raw diff
(see #3).

---

## Suggested shape after the fixes

```ts
import { z } from 'zod';
import type { Finding as FindingType, LLMProvider, UnifiedDiff } from '@devdigest/shared';
import { Finding } from '@devdigest/shared';
import { assemblePrompt } from '../prompt.js';
import { groundFindings, groundingSummary } from '../grounding.js';

const SummaryPayload = z.object({
  headline: z.string(),
  findings: z.array(Finding),
});

export interface SummarizeInput {
  systemPrompt: string;
  model: string;
  llm: LLMProvider;          // injected port — no provider construction here
  diff: UnifiedDiff;
  skills?: string[];         // RESOLVED bodies, already trust-formatted by the caller
  task?: string;
  maxRetries?: number;
  sessionId?: string;
}

export interface SummarizeOutcome {
  headline: string;
  findings: FindingType[];
  dropped: { finding: FindingType; reason: string }[];
  grounding: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
  raw: string;
}
```

No `node:fs`, no `process.env`, no `new OpenRouterProvider`, grounding applied
unconditionally — i.e. the same shape `reviewPullRequest` already has.
