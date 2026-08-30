# PR review — `reviewer-core/src/review/summarize.ts` (second-pass summariser)

**Verdict: request changes.** The file does not compile, and it breaks three of
the four load-bearing invariants of `reviewer-core` at once (no I/O, injected
`LLMProvider`, mandatory grounding). It also introduces an arbitrary-file-read
path that ends inside an LLM prompt.

Findings are ordered most important first. Line numbers refer to the proposed
file as reviewed.

---

## 1. CRITICAL — The engine constructs its own LLM provider and reads a secret from `process.env`

**`reviewer-core/src/review/summarize.ts:5, 39–41`**

```ts
import { OpenRouterProvider } from '../llm/openrouter.js';
...
const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error('OPENROUTER_API_KEY is not configured');
const llm = new OpenRouterProvider(key, { timeoutMs: 60_000 });
```

This is the single most serious problem. The package contract is stated in three
places and this violates all of them:

- `reviewer-core/src/index.ts:5-7` — "NO database, GitHub, or filesystem access;
  the only side effect is an LLM call through an **INJECTED** LLMProvider (so it
  is mock-testable)."
- `reviewer-core/package.json` `description` — "No DB/GitHub/FS; the only side
  effect is an injected LLMProvider."
- `reviewer-core/CLAUDE.md` — same rule.

`grep -rn "process\.env" reviewer-core/src` returns **nothing** today. This PR
would be the first.

Concrete consequences, not just a style point:

1. **Provider choice is silently overridden.** The studio resolves a provider per
   agent from `agents.provider` (`openai` | `anthropic` | `openrouter`) in
   `server/src/platform/container.ts:169-200`. A workspace configured for
   Anthropic or OpenAI would still have this pass go out over OpenRouter.
2. **Secrets policy is bypassed.** Root `CLAUDE.md`: "Secrets (LLM/GitHub keys)
   live in `~/.devdigest/secrets.json` (mode 0600), never `.env`/DB." Every
   other key read in the repo goes through `this.secrets.get('OPENROUTER_API_KEY')`
   (`server/src/platform/container.ts:151, 191`). Reading `process.env` here
   creates a second, undocumented key source that the settings UI cannot see and
   the secrets store cannot rotate.
3. **Cost attribution is lost.** `container.buildLlm` injects `estimateCost` from
   the live `PriceBook` (`container.ts:194-197`). Constructing the provider bare
   means `costUsd` falls back to whatever OpenRouter happens to return, with no
   price-book fallback for the cold-cache case.
4. **Untestable.** The whole test corpus (`reviewer-core/test/run.test.ts`)
   works by passing a stubbed `LLMProvider`. There is no seam here to stub, so
   `summarizeReview` cannot be tested without a real key and a network call —
   which `reviewer-core/README.md` explicitly forbids ("No keys, no network").

**Fix:** take the provider and the model as inputs, exactly as `ReviewInput`
does (`reviewer-core/src/review/run.ts:48-53`):

```ts
export interface SummarizeInput {
  systemPrompt: string;
  /** Model id understood by the injected provider. */
  model: string;
  diff: UnifiedDiff;
  /** Injected LLM provider. */
  llm: LLMProvider;
  ...
}
```

Delete the `OpenRouterProvider` import, the `process.env` read, and the
`SUMMARY_MODEL` constant. The caller (`server/src/modules/reviews/run-executor.ts`,
via `container.llm(agent.provider)`) already has both.

---

## 2. CRITICAL — Filesystem I/O inside the pure engine, with no path containment (arbitrary file read → LLM prompt)

**`reviewer-core/src/review/summarize.ts:1, 19–20, 43–46`**

```ts
import { readFile } from 'node:fs/promises';
...
/** Absolute paths of the skill files this agent has enabled. */
skillPaths?: string[];
...
for (const path of input.skillPaths ?? []) {
  skills.push(await readFile(path, 'utf8'));
}
```

Two distinct problems stacked on one loop.

**(a) It is filesystem access in a package defined by not having any.** As with
finding 1, `grep -rn "node:fs" reviewer-core/src` currently returns nothing. The
established division of labour is explicit in `ReviewInput` (`run.ts:56`):
*"Resolved skill bodies (NOT slugs)"* and `run.ts:26-27`: *"the caller turns
AgentManifest skill slugs into bodies (DB in the studio, fs in the runner)."*
The studio reads skills from **Postgres**, not from disk — so `skillPaths` is a
shape the studio cannot even produce. This input only makes sense for the CI
runner, and encoding one caller's storage medium into the shared engine is
precisely what the package is structured to prevent.

**(b) It is an unvalidated absolute-path read whose contents are sent to a third
party.** There is no containment check of any kind. Anything that can influence
`skillPaths` — a DB row, an agent manifest, a repo-committed config — can name
`~/.devdigest/secrets.json`, `~/.ssh/id_ed25519`, or `/etc/passwd`, and the file
body is inlined into the prompt and shipped to OpenRouter. The repository already
has the gate this needs and treats it as a security boundary:
`server/src/modules/context/helpers.ts:41-61` (`safeContextPath`, which delegates
to `safeRepoRelativePath`) exists specifically because "`GitClient.readFile` …
joins onto the clone dir with no containment check of its own."

**Fix:** delete the import, the loop, and the `skillPaths` field. Accept
`skills?: string[]` (already-resolved bodies) like `ReviewInput` does. If the CI
runner needs to read them from disk, it does so on its own side, behind
`safeRepoRelativePath`.

*Secondary defects in the same loop, which disappear with the fix:* the reads are
awaited sequentially rather than via `Promise.all`, and an unhandled `ENOENT` on
one skill file rejects the entire summarise — whereas the server's equivalent
path deliberately degrades (`run-executor.ts:434`: "Returns [] on any failure — a
skills lookup must never fail a review").

---

## 3. CRITICAL — The mandatory citation-grounding gate is skipped

**`reviewer-core/src/review/summarize.ts:62–66`**

```ts
return {
  headline: result.data.headline,
  findings: result.data.findings,
  model: SUMMARY_MODEL,
};
```

Model-authored `Finding` objects — each carrying a `file`, `start_line` and
`end_line` — are returned to the caller **verbatim**. Nothing calls
`groundFindings()`.

This is the one rule the repo states as non-negotiable in every layer:

- Root `CLAUDE.md`: "Review grounding is mandatory across the pipeline — every
  finding must cite a real diff line or it's dropped."
- `reviewer-core/CLAUDE.md` Gotchas: "Grounding is mandatory — never bypass
  `groundFindings()`."
- `reviewer-core/README.md`: "a finding that doesn't cite a real line in the diff
  is dropped, so the engine can't hallucinate locations."
- `run.ts:216-217` does it as "the only post-step; not duplicated per strategy."

The blast radius is worse than for the main pass, because the doc comment
(lines 34-36) says these are "the findings worth surfacing **above the fold** on
the PR page". Ungrounded findings would be the most prominent thing a reviewer
sees, and a hallucinated `file`/`start_line` will render an inline comment
against a line that does not exist in the diff (`toReviewPayload` maps findings
straight to `comments: {path, line, body}` — `shared/adapters.ts` `GitHubReviewPayload`).

**Fix:** run the surviving findings through the gate and return the drops, as
`ReviewOutcome` does (`run.ts:113-114`):

```ts
const ground = groundFindings(result.data.findings, input.diff);
return { headline: ..., findings: ground.kept, dropped: ground.dropped, ... };
```

See also finding 10 — the scope filter is missing for the same reason.

---

## 4. CRITICAL — The file does not compile

`npm run typecheck` **is** the build for this package (`reviewer-core/package.json`,
`CLAUDE.md`). I ran `tsc --noEmit` against an isolated copy of `reviewer-core/src`
with this file dropped in as `src/review/summarize.ts`. Six errors:

| Line | Error | Cause |
|---|---|---|
| 50 | `TS2322: Type 'UnifiedDiff' is not assignable to type 'string'` | `PromptParts.diff` is a **string**. Pass `input.diff.raw` (`run.ts:161, 166`). |
| 49 | `TS2353: 'systemPrompt' does not exist in type 'PromptParts'` | The slot is named `system`, not `systemPrompt` (`prompt.ts:200`). `run.ts:149` maps `system: input.systemPrompt`. |
| 57 | `TS2353: 'system' does not exist in type 'StructuredRequest<unknown>'` | `StructuredRequest` takes `messages: ChatMessage[]`, not `system`/`user` (`shared/adapters.ts:55-69`). |
| 57 | `TS2339: Property 'system' does not exist on type 'AssembledPrompt'` | `assemblePrompt` returns `{ messages, assembly }` (`prompt.ts:255`). `system`/`user` live on `prompt.assembly`, and are the *trace record*, not the call input. |
| 58 | `TS2339: Property 'user' does not exist on type 'AssembledPrompt'` | same |
| 63, 64 | `TS18046: 'result.data' is of type 'unknown'` | consequence of the malformed request literal — `T` cannot be inferred. |

Additionally, `schemaName` is a **required** field of `StructuredRequest` and is
absent; it will surface as a seventh error once the `system`/`user` keys are
removed. It is not cosmetic — `schemaName` is what `toJsonSchema` names the
schema with and what every error message in `openrouter.ts:96, 150-152` reports.

**Fix:** the call should mirror `run.ts:192-199`:

```ts
const a = assemblePrompt({ system: input.systemPrompt, diff: input.diff.raw, skills, task: input.task });
const res = await input.llm.completeStructured<SummaryPayload>({
  model: input.model,
  schema: SummaryPayload,
  schemaName: 'SummaryPayload',
  messages: a.messages,
  maxRetries: input.maxRetries ?? DEFAULT_REVIEW_MAX_RETRIES,
  ...(input.sessionId ? { sessionId: input.sessionId } : {}),
});
```

Note that this PR could not have been run even once locally — worth asking the
author how it was exercised.

---

## 5. CRITICAL — `z.custom<Finding>()` validates nothing; `SummarizeOutcome.findings: Finding[]` is a false type

**`reviewer-core/src/review/summarize.ts:9–12, 28`**

```ts
const SummaryPayload = z.object({
  headline: z.string(),
  findings: z.array(z.custom<Finding>()),
});
```

`z.custom<T>()` with no validator function is a compile-time cast with a
**no-op runtime check**. `@devdigest/shared` already exports a real `Finding`
Zod schema (`server/src/vendor/shared/contracts/findings.ts:47`) — `run.ts:9`
imports the sibling `Review as ReviewSchema` for exactly this purpose.

I verified both halves of the damage against this package's own `zod` and
`openai` versions:

**Runtime — everything passes:**

```
S.safeParse({ headline: 'x', findings: [{nonsense:true}, 42, null] })
→ { "success": true, ... }
```

So `parseWithRepair` (`llm/structured.ts:74`) succeeds on garbage, the repair
loop never fires, and `42` and `null` are handed back to the caller typed as
`Finding[]`. The first downstream `finding.file` or `finding.severity` access —
in grounding, in `toReviewPayload`, or in the client — throws on data the type
system promised was safe.

**Prompt side — the model is told nothing:** `toJsonSchema(SummaryPayload)`
emits

```json
"findings": { "type": "array" }
```

with **no `items`**. The model receives zero guidance about what a finding looks
like (no `severity`, `file`, `start_line`, `confidence`), and OpenAI-compatible
strict `json_schema` mode — which `openrouter.ts:79-82` always sets
`strict: true` — requires `items` on an array.

**Fix:** `import { Finding as FindingSchema } from '@devdigest/shared'` and use
`z.array(FindingSchema)`. Never `z.custom` for a payload crossing the LLM
boundary.

---

## 6. HIGH — Skill bodies bypass `formatSkillBlocks`, collapsing a documented trust boundary

**`reviewer-core/src/review/summarize.ts:43–53`**

```ts
const skills: string[] = [];
for (const path of input.skillPaths ?? []) {
  skills.push(await readFile(path, 'utf8'));
}
const prompt = assemblePrompt({ ..., skills, ... });
```

Raw file bodies go straight into the `skills` slot, which `assemblePrompt`
joins verbatim into `## Skills / rules` (`prompt.ts:203-204, 232`) — i.e. into
**instruction position**, outside any `<untrusted>` wrapper, where the
`INJECTION_GUARD` does not reach them.

The correct path is `formatSkillBlocks` (`prompt.ts:76-82`), which wraps
anything not authored in this workspace. This is a deliberate, recorded design
decision, `reviewer-core/INSIGHTS.md`, 2026-07-19:

> It sits here because two callers need the identical rule … Implementing it on
> the server side would let the two silently diverge, and the divergence would
> be a **prompt-injection hole rather than a cosmetic bug**.

The server honours it (`run-executor.ts:454-459`, passing
`trusted: l.skill.source === 'manual'`). This summariser would be the one path
that does not — meaning an imported/community skill body gets to rewrite the
summariser's instructions, and the summariser is the output that lands "above
the fold".

**Fix:** accept `SkillBlock[]` (or pre-formatted blocks from the caller) and
route through `formatSkillBlocks`. Never build the `skills` slot by hand.

---

## 7. HIGH — Model id is hardcoded, and is not one of the repo's documented options

**`reviewer-core/src/review/summarize.ts:7, 65`**

```ts
const SUMMARY_MODEL = 'anthropic/claude-3.5-haiku';
```

Model selection is per-agent configuration in this codebase:
`agents.provider` + `agents.model`, changeable in the studio dropdown or via
`PUT /agents/:id` (`docs/agent-prompts/choosing-a-model.md:3-6`).
`ReviewInput.model` (`run.ts:49`) is how the engine receives it. Burying a
constant here means the summariser silently ignores the user's choice and cannot
be changed without a code deploy.

Separately, `anthropic/claude-3.5-haiku` appears nowhere in
`docs/agent-prompts/choosing-a-model.md`; the documented cheap-Claude option is
`anthropic/claude-haiku-4.5`, and the default is
`openrouter` / `deepseek/deepseek-v4-flash`. At minimum this is an undiscussed,
un-costed model choice that no one signed off on; at worst it is a stale id.

**Fix:** add `model: string` to `SummarizeInput` and pass it through
(`model: input.model` in both the request and the returned `model` field).

---

## 8. MEDIUM — Not exported from the package entry point

**`reviewer-core/src/index.ts`** (unchanged by this PR)

`index.ts` is the curated public surface — every engine capability is re-exported
there with a comment (`run.ts` at lines 54-63, `reduce.ts` at 51, `to-review.ts`
at 66-71). `summarizeReview` is not added, so the only consumer (`server`, which
imports from `'@devdigest/reviewer-core'` — see `run-executor.ts:4`) cannot
reach it. As written this PR ships dead code.

**Fix:** add to `index.ts`:

```ts
// Second pass: grounded review → reader-facing headline + above-the-fold findings.
export { summarizeReview, type SummarizeInput, type SummarizeOutcome } from './review/summarize.js';
```

---

## 9. MEDIUM — The outcome discards token counts, cost, the raw output, and the prompt assembly

**`reviewer-core/src/review/summarize.ts:25–29, 62–66`**

```ts
export interface SummarizeOutcome {
  headline: string;
  findings: Finding[];
  model: string;
}
```

`completeStructured` returns `tokensIn`, `tokensOut`, `costUsd`, `raw` and
`attempts` (`shared/adapters.ts:71-79`); all are thrown away. `ReviewOutcome`
(`run.ts:122-130`) deliberately surfaces `assembly`, `tokensIn`, `tokensOut`,
`costUsd` and `raw` because the server persists them into `run_traces` and the
studio's Run Trace drawer renders them (see `INSIGHTS.md` 2026-08-22:
"`PromptAssembly.system` is persisted into `run_traces`").

Result: this second LLM call is invisible in the trace and free-looking in the
cost report, while actually roughly doubling per-review spend.

**Fix:** widen `SummarizeOutcome` to carry `assembly`, `tokensIn`, `tokensOut`,
`costUsd`, `raw`, matching `ReviewOutcome`'s field names exactly so the server
can aggregate without a mapping layer.

---

## 10. MEDIUM — No scope filter, so demoted findings can reappear at full severity

**`reviewer-core/src/review/summarize.ts:62–66`**

The main path applies `applyScopeFilter` after grounding (`run.ts:224`), which
demotes (never deletes) findings the PR's derived intent puts out of scope, and
recomputes the score from the post-demotion severities. This pass re-derives
findings from the raw diff with no `intent` input at all — so a finding the main
pass demoted to `LOW` and tagged `out_of_scope` can come back through the
summariser at `CRITICAL` and land above the fold. The two surfaces will visibly
disagree about the same PR.

**Fix:** accept `intent?: IntentForPrompt`, pass it to `assemblePrompt`, and run
`applyScopeFilter` after grounding — or adopt the restructure in the design note
below, which removes the problem by construction.

---

## 11. MEDIUM — No `sessionId`, `maxRetries`, `onEvent`, or `checkCancelled`

**`reviewer-core/src/review/summarize.ts:55–60`**

Four plumbing hooks the sibling entry point takes and this one does not
(`run.ts:89-105`):

- **`sessionId`** — `openrouter.ts:85` sends it so every generation of one
  review groups into a single OpenRouter session. Without it, the summariser
  call is orphaned in the dashboard.
- **`maxRetries`** — defaults to the provider's 2 rather than the package's
  `DEFAULT_REVIEW_MAX_RETRIES`; harmless today but it is the constant that
  exists to keep these aligned.
- **`onEvent`** — no progress events, so the studio's SSE stream goes quiet for
  the duration of a second full-diff LLM call.
- **`checkCancelled`** — the run cannot be cancelled during this pass. `run.ts:101-105`
  calls it "before each (expensive) chunk LLM call"; this is one of those.

Also unexplained: `timeoutMs: 60_000` (line 41) undercuts the provider default of
90s (`openrouter.ts:54`) with no rationale, on a call that reads a whole diff.
That decision belongs to the caller anyway once the provider is injected.

---

## 12. LOW — No tests

`reviewer-core/test/` holds seven suites and `README.md` describes them as
"hermetic units with a stubbed `LLMProvider` … No keys, no network." This PR adds
a new engine entry point with none. Once finding 1 is fixed the provider is
injectable and the tests are straightforward; the cases worth pinning are: the
grounding gate actually drops an ungrounded finding, `SummaryPayload` **rejects**
a malformed finding (finding 5 above — a real regression guard), and skills reach
the prompt delimiter-wrapped when untrusted (finding 6).

Worth flagging to the author: per `reviewer-core/INSIGHTS.md` 2026-08-11,
`tsconfig.json`'s `include` is `["src/**/*.ts"]`, so `npm run typecheck` does
**not** typecheck files under `test/`. A green typecheck says nothing about the
new tests' types.

---

## Design note — reconsider the shape of the whole feature

Beyond the individual defects: the doc comment (line 35) says this pass
"**re-reads the same diff**". That choice is what forces findings 3, 5 and 10 to
exist, and it doubles the token cost of every review
(`docs/agent-prompts/choosing-a-model.md` puts a single pass at ~12k in / ~1.5k
out).

If the summariser instead took the **already-grounded** `ReviewOutcome` from
`reviewPullRequest` and asked only for a headline plus an ordering/selection of
findings *by id*, then:

- grounding cannot be bypassed (the inputs are already grounded);
- scope demotions are preserved automatically;
- no `Finding` schema round-trips through the model, so finding 5 evaporates;
- the second call is short and cheap (ids + titles, not the whole diff);
- the two surfaces can never disagree about a PR.

I'd want that alternative explicitly ruled out before merging this shape.

---

## Summary of required changes before merge

1. Take `llm: LLMProvider` and `model: string` as inputs; delete the
   `OpenRouterProvider` construction and the `process.env` read.
2. Delete the `node:fs` import and `skillPaths`; accept resolved skill bodies.
3. Call `groundFindings()` (and `applyScopeFilter`) before returning; return the
   drops.
4. Make it compile — `system` not `systemPrompt`, `input.diff.raw`, `messages`
   not `system`/`user`, add `schemaName`.
5. Use the real `Finding` schema from `@devdigest/shared`, not `z.custom`.
6. Route skills through `formatSkillBlocks`.
7. Export from `src/index.ts`; surface tokens/cost/raw/assembly on the outcome.
8. Add hermetic tests with a stubbed provider.
