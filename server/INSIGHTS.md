# INSIGHTS — server

Non-obvious decisions, gotchas, and "why is this built this way" for `server`.
Read before changing a long-standing convention, or when something behaves
surprisingly that the code alone doesn't explain.

Captured via the `engineering-insights` skill — see
[`.claude/skills/engineering-insights/SKILL.md`](../.claude/skills/engineering-insights/SKILL.md)
for entry format and the append-only rule. Sections are fixed; don't add,
remove, or rename them. Code under `src/modules/repo-intel/**` belongs
here too — it's a module inside `server`, not its own package.

## What Works

_Nothing recorded yet._

## What Doesn't Work

### 2026-07-20 — [Mistake] The seeded "API Contract Reviewer" cannot be the baseline in a skills A/B

Measuring "does linking a skill change the review?" against that agent proves
nothing: its own `system_prompt` is already an exhaustive breaking-change
detector (renamed response fields, Zod response-schema stripping, status-code
changes), and it ships with `api-contract-guard` linked, which repeats the same
material as a table. Disabling the skill links still leaves the prompt, so the
"without skills" arm catches the break anyway. A meaningful A/B needs a fresh
agent with a deliberately generic prompt — measured here as approve/score 100/0
findings without skills vs `request_changes`/3 CRITICAL findings with them, on
one unchanged diff. Evidence: `server/src/db/seed-prompts.ts:591`,
`server/src/db/seed.ts:349`.

### 2026-07-20 — [Mistake] `drizzle-kit generate` blocks on an interactive prompt when one migration both adds and drops columns

Changing `conventions.accepted` (boolean) into `status` (enum) in a single
schema edit makes drizzle-kit ask "created or renamed?" per column, and the
prompt needs a TTY — piping newlines (`printf '\n\n' | pnpm db:generate`) does
not answer it and the command just hangs. Split the change into two generates
instead: first the pure additions (leaving the old column in the schema), then
a second pass that only drops it. Both are unambiguous, so neither prompts.
Evidence: `server/src/db/migrations/0012_nebulous_machine_man.sql`,
`server/src/db/migrations/0013_groovy_marvel_zombies.sql`.

### 2026-08-11 — [Mistake] An integration test that injects only SOME providers silently hits the real network

`reviews.it.test.ts` overrode `llm: { openai: mock }` and passed for months. The
moment a review run also called `container.llm('openrouter')` (the intent
classifier), the un-injected provider fell through to `LocalSecretsProvider`,
found a real `OPENROUTER_API_KEY` in `~/.devdigest/secrets.json`, and the test
started making live, billed API calls. It did not fail loudly — it blew
`waitForPrRuns`' 10s budget, so `reviewsForPull` returned `[]` and the failure
read as "no review was persisted" (`reviews[0]` undefined), pointing nowhere
near the cause. Runtime went 2.6s → 38s, which is the real tell. Any test
exercising a code path that resolves a provider must inject EVERY provider that
path can reach; `ContainerOverrides.llm` is a partial record, so omitting one is
silent by design. Evidence: `server/test/reviews.it.test.ts:129`,
`server/src/platform/container.ts` (`buildLlm`).

### 2026-08-11 — [Mistake] A Fastify route with an `.optional()` Zod body still 422s a body-less POST

`POST /pulls/:id/intent/detect` declared `body: z.object({force: z.boolean().optional()}).optional()`
and every body-less `app.inject({method:'POST'})` returned 422 `validation_error`
— `.optional()` on the schema does not make the request body optional to
Fastify. The two working escapes are the reviews module's tolerant manual parse
(`RunRequest.parse(req.body ?? {})`, deliberately deviating from the
Zod-schema-only house rule) or, when the route genuinely takes no arguments,
declaring no `body` schema at all. The same trap is already noted from the
client side in `client/src/lib/api.ts`'s content-type comment. Evidence:
`server/src/modules/intent/routes.ts:35-44`, `server/src/modules/reviews/routes.ts:32`.

### 2026-08-20 — [Mistake] `getResolvedCallers` inner-joined `file_rank`, so a partial index reported ZERO callers

`pipeline/full.ts` skips its entire T3 block — `replaceEdges`, `replaceFileRank`
**and** `replaceFileFacts` — behind one `if (!softBudgetReached)`, while still
writing symbols and references and stamping `status: 'partial'`. An inner join
on `file_rank` therefore dropped every caller row for such a repo, and the blast
panel rendered "no downstream callers": a false claim about the *code*, produced
by a gap in the *index*. Fixed with a `leftJoin` + `coalesce(rank, 0)` — rank 0
is what the old ripgrep path already used and the rank sort tolerates it. Any
future query joining `file_rank`, `file_edges` or `file_facts` must assume those
tables can be empty on a `partial` index. Evidence:
`server/src/modules/repo-intel/repository.ts:503-540`,
`server/src/modules/repo-intel/pipeline/full.ts:214`.

### 2026-08-28 — [Mistake] `pnpm typecheck` cannot catch a breaking `reviewer-core` type change that only `server/test/**` consumes

Widening `PromptParts.specs` from `string[]` to `{path, content}[]` typechecked
clean in ALL THREE packages and still broke the server unit lane at runtime:
`server/tsconfig.json:28` is `"include": ["src/**/*.ts"]`, so two test fixtures
passing bare strings were invisible to `tsc` and failed as
`TypeError: Cannot read properties of undefined (reading 'replaceAll')` inside
`wrapUntrusted`. This is the server-side twin of the `reviewer-core/INSIGHTS.md`
2026-08-11 entry, and it EXTENDS the 2026-08-20 shared-contract entry: that one
is about `vendor/shared` schemas parsed by `contracts.test.ts`; this one is about
a type crossing the tsconfig path alias, where no `src/` grep finds the breakage
either. After any `reviewer-core` signature change, grep `server/test/` for the
changed field and run the unit lane. Evidence: `server/test/prompt-callers.test.ts:20`,
`server/test/prompt-structured.test.ts:19`, `reviewer-core/src/prompt.ts:124`.

### 2026-08-28 — [Mistake] A transaction does NOT make delete-then-insert safe against a concurrent write of the same owner

`ContextRepository.replace` wrapped `DELETE ... WHERE owner = ?` plus
`INSERT VALUES (...)` in `db.transaction` and looked correct. It is not: under
READ COMMITTED two overlapping requests interleave — T2's DELETE evaluates
against the snapshot from before T1 committed, so it removes nothing, and T2's
INSERT then collides with the row T1 just wrote, giving
`duplicate key value violates unique constraint "skill_context_files_skill_id_path_pk"`
as a bare HTTP 500. Two quick checkbox clicks in the editor were enough. The fix
is a `FOR UPDATE` on the OWNER row as the transaction's first statement
(`tx.select({id}).from(t.skills).where(eq(t.skills.id, ownerId)).for('update')`),
which serializes replaces per owner while leaving different owners parallel.
Reproduced by two `Promise.all` injects against one owner — that test 500s
without the lock. **`AgentsRepository.setSkills` has the identical shape and the
same latent race.** Evidence: `server/src/modules/context/repository.ts`
(`replace`), `server/test/context.it.test.ts` ("survives two concurrent
replaces of the SAME skill").

### 2026-08-28 — [Context] Making a write optimistic on the client turns a latent server race into a reproducible one

The duplicate-key race above had existed since the table shipped and never
fired, because the UI waited for each response before allowing the next click.
Adding optimistic cache updates made clicking instant, so the author naturally
ticks four boxes in a row and the PUTs overlap. The client change did not
introduce the defect; it changed the traffic shape enough to expose it. Worth
remembering before adding optimistic UI over any endpoint that does
read-modify-write or delete-then-insert: check the write for concurrency safety
in the same change. Evidence: `client/src/lib/hooks/context.ts` (`onMutate`),
`server/src/modules/context/repository.ts` (`replace`).

## Codebase Patterns

### 2026-06-24 — [Decision] "Latest review round" needs a shared `ranAt`, not each row's own `defaultNow()`

`agentRuns.ranAt` defaults independently per row (`pgTable` `.defaultNow()`), so N agents queued by one "Run Review" click used to land at N slightly different timestamps with no shared identifier. To let a caller compute "the latest batch of runs for this PR" (e.g. a cost rollup), `ReviewService.runReview()` now captures one `const ranAt = new Date()` before the create-loop and passes it through `createAgentRun({ ..., ranAt })` for every job in that batch, so "latest round" = the `agent_runs` rows sharing a PR's max `ran_at`. Evidence: `server/src/modules/reviews/service.ts:122`.

### 2026-06-24 — [Decision] `PrMeta`/`PrDetail` fields populated only on the list endpoint must be `.nullish()`, not `.nullable()`

`PrDetail = PrMeta.extend({...})` (`server/src/vendor/shared/contracts/platform.ts:203`), but the `/pulls/:id` detail route builds its response from two code paths — the GitHub-refreshed branch (`return { ...detail, id: pr.id }`) and the offline fallback (a hand-built literal) — neither of which sets `score` or `cost_usd` at all (`server/src/modules/pulls/routes.ts:246`, `:251`). A `PrMeta` field that's only computed by the `/repos/:id/pulls` list route (like `score`, and now `cost_usd`) must use `.nullish()` so the key can be omitted entirely; `.nullable()` requires the key present and breaks response serialization for `PrDetail`. Evidence: `server/src/vendor/shared/contracts/platform.ts:176`.

### 2026-06-24 — [Context] `run_traces.trace` is a frozen JSONB snapshot — mutating `agent_runs` afterward doesn't change it

The trace document persisted to `run_traces` (via `saveRunTrace`) is built once at run completion and never re-derived. Updating `agent_runs.cost_usd` (or any other stat) on an already-completed run has no effect on that run's previously-saved trace — the Run Trace drawer's Stats card will keep showing the value frozen at completion time, even though the timeline (which reads live from `agent_runs`) reflects the update immediately. Confirmed by directly nulling `agent_runs.cost_usd` for a completed run: the timeline showed `–`, the trace drawer still showed the original `$0.0001`. Evidence: `server/src/modules/reviews/run-executor.ts:289`.

### 2026-07-19 — [Context] A skill block needs BOTH enable flags, and reordering must preserve the link flag

Injecting a skill at review time requires `agent_skills.enabled` (does this link
contribute a block) AND `skills.enabled` (is the skill live at all) — they are
independent, and `run-executor.ts:360` filters on both. Because `setSkills`
implements reordering as delete-then-insert, the per-link flags must be read and
re-applied inside the same transaction, or a drag-to-reorder silently
resurrects every link the user had switched off. The transaction also closes a
pre-existing hole where a mid-swap failure dropped all of an agent's links.
Evidence: `server/src/modules/agents/repository.ts:234`,
`server/src/modules/reviews/run-executor.ts:360`.

### 2026-07-20 — [Decision] Conventions extraction keeps its own cheap-model default via `getFeatureModelOverride`

`FEATURE_MODELS` lists `conventions` with a default of `openai/gpt-5.4`, but the
module calls `getFeatureModelOverride` (returns `undefined` when unset) rather
than `resolveFeatureModel` (substitutes that registry default), so an unset
workspace falls back to the module's own `openrouter/deepseek-v4-flash`.
Deliberate: extraction is a bulk pass whose every output is then re-verified
line-by-line against the clone, so frontier pricing buys nothing the grounding
gate doesn't already enforce — and the dev box only holds an OpenRouter key, so
the registry default would fail outright. `feature-models.ts` anticipates this
caller by name. Evidence: `server/src/modules/settings/feature-models.ts:34`,
`server/src/modules/conventions/constants.ts`.

### 2026-08-11 — [Context] `now()` in `db/schema/_shared.ts` is a `created_at` factory, not a generic timestamptz helper

The helper hard-codes the column NAME: `timestamp('created_at', …)`. Using it
for any other timestamp column (`generated_at`, `indexed_at`, …) silently
produces a column called `created_at` in the migration. Spell those out inline
instead — `timestamp('generated_at', { withTimezone: true }).defaultNow().notNull()`
is exactly `now()`'s body with the right name. Evidence:
`server/src/db/schema/_shared.ts:9`, `server/src/db/schema/reviews.ts` (`prIntent.generatedAt`).

### 2026-08-11 — [Decision] The intent module uses `resolveFeatureModel`, unlike the conventions module

The 2026-07-20 entry above records conventions calling `getFeatureModelOverride`
plus a module-local cheap default, because the registry default for that feature
was `openai/gpt-5.4` and the dev box holds only an OpenRouter key. The intent
layer took the other route: the `review_intent` registry default was CHANGED to
`openrouter/deepseek-v4-flash` in both vendored `platform.ts` copies plus the
hand-maintained `client/src/lib/feature-models.ts` mirror, so `resolveFeatureModel`
is correct and there is only one default to reason about. The cost is a
three-file synchronized edit; the benefit is that Settings, the module and the
registry cannot disagree. Evidence: `server/src/modules/intent/service.ts:184`,
`server/src/vendor/shared/contracts/platform.ts:55`.

### 2026-08-12 — [Context] `repoIntel.getBlastRadius` only returns `factsByFile` on the persistent index path

`BlastResult.factsByFile` (the per-caller-file endpoint/cron map) is present on
the T3 persistent-index path and **absent** on the degraded ripgrep path, where
only the flat `impactedEndpoints` union survives. Endpoint-to-symbol attribution
is therefore impossible when degraded: `toBlastRadius` leaves every symbol's
`endpoints_affected` empty and reports the flat union at the top level rather
than smearing all endpoints across all symbols, which would state a relationship
the index never found. Any future consumer of this facade has to make the same
choice explicitly — the type makes the field optional but not the reason.
Evidence: `server/src/modules/repo-intel/types.ts:79-84`,
`server/src/modules/blast/helpers.ts:22-45`.

### 2026-08-13 — [Decision] Skill usage stats are an association with the AGENT, never attribution to the skill

Nothing in the schema records which skill provoked a finding: `findings` hangs
off `reviews`, and a review knows only its `agent_id`. So `GET /skills/:id/stats`
can only report findings produced by agents that link the skill — the contract
docblock and the tab subtitle both say so, deliberately. Similarly, no table
links a run to a skill, so `pull_frequency` is derived by looking for the
`### <name>` heading `formatSkillBlocks` writes into
`run_traces.trace.prompt_assembly.skills` (via `strpos`, which is a literal
search and needs no `LIKE` escaping). That means a renamed skill orphans its
history and a name that prefixes another skill's name can over-match; fixing it
properly needs a `run_skills` link table written at review time. Rates return
`null` rather than `0` when the denominator is empty, because "never used" and
"offered and never pulled" are different facts. Evidence:
`server/src/modules/reviews/repository/skill-stats.repo.ts`,
`server/src/modules/skills/helpers.ts:ratio`, `test/skills-stats.it.test.ts`.

### 2026-08-13 — [Context] `used_by_agents` and `Agent.skills_count` count deliberately different things

Both count `agent_skills` rows and they disagree on purpose. `skills_count` on
the agent DTO requires BOTH `agent_skills.enabled` and `skills.enabled` — the
question there is "how many blocks does this agent actually get". `used_by_agents`
on the skill's Stats tab gates only on the link, because the skill's own switch
is already visible as the card toggle and gating on it would show "0 agents" for
every disabled skill. Don't "fix" one to match the other. `skills_count` is also
optional and omitted (not zeroed) on single-agent reads, since only the list
endpoint pays for the grouped count. Evidence:
`server/src/modules/agents/repository.ts:countEnabledSkillsByAgent`,
`server/src/modules/skills/service.ts:stats`.

### 2026-08-20 — [Context] The import graph is stored importer→imported, so blast must walk it BACKWARDS

`file_edges` rows are `(from_file imports to_file)`, and the only reader before
this session (`getEdges` → `getCriticalPaths`) builds a forward adjacency map.
A blast radius needs the opposite question — "who depends on this file" — which
is why the schema carries `file_edges_repo_to_idx` on `(repo_id, to_file)`. That
index sat unused for two tiers; nothing filtered on `toFile` anywhere.
`getImporters` is the intended reader: one indexed query per hop, `BFS_DEPTH`
hops, visited-set so cycles terminate, seeds excluded so a changed file is never
its own dependent. Getting the direction wrong yields a plausible-looking map
that lists the changed file's own dependencies. Evidence:
`server/src/db/schema/repo-intel.ts:55-68`,
`server/src/modules/repo-intel/repository.ts:560-620`.

### 2026-08-20 — [Decision] Supersedes the 2026-08-12 `factsByFile` entry — blast no longer has a degraded path

`getBlastRadius` is now index-only: when the flag is off, no state row exists, or
the status is `degraded`/`failed`, it returns an empty `BlastResult` tagged with
the real `DegradedReason` instead of falling back to parsing the clone. The
ripgrep fallback re-read source on the hot path, produced `rank: 0` and no
`factsByFile`, and was quietly worse than the index it stood in for. The earlier
entry's *rule* still holds and is now the general one: attribute an endpoint to a
symbol only on evidence (a caller in that file, or a ≤2-hop reverse-import edge),
never by smearing the flat union. `factsByFile` is present whenever a map is
served at all. Evidence: `server/src/modules/repo-intel/service.ts:211-243`,
`server/src/modules/blast/helpers.ts:20-80`.

### 2026-08-20 — [Decision] A caller cap belongs per-symbol, not on the flat list

`tryPersistentBlast` used to `slice(0, MAX_CALLERS_PER_SYMBOL)` the flat caller
array, which capped 20 callers TOTAL across every changed symbol despite the
constant's name — one wide-fan-out symbol starved every other symbol of callers
it genuinely had. Callers are now grouped by `viaSymbol`, sorted by rank within
the group, and sliced per group, with the pre-truncation size returned in
`callerTotals` so the UI can say "showing 20 of 43" instead of presenting a
truncated list as the whole set. Evidence:
`server/src/modules/repo-intel/service.ts:310-330`.


### 2026-08-20 — [Mistake] Depth-2 endpoint attribution is near-worthless through a barrel file

The first live run of the blast map attributed `GET /health` to a change in
`reviews/routes.ts`. The path is real — `reviews/routes.ts ← modules/index.ts ←
app.ts`, and `app.ts` declares `/health` — but a registry/barrel file puts EVERY
module two hops from the app root, so flat depth-2 attribution converges on
"every change affects every endpoint". The unit tests could not surface this:
their graphs are 2-4 synthetic nodes with no barrel. Fixed by carrying the hop
distance on each attributed endpoint (`AffectedEndpoint`) so the UI collapses
depth 2 behind a disclosure and MCP puts it in a separate `*_indirect` key —
walking less far would have lost real impact in repos that have no barrel. Any
future graph-derived claim in this codebase should carry its distance rather
than being flattened to a boolean. Evidence:
`server/src/modules/blast/helpers.ts`,
`server/src/vendor/shared/contracts/brief.ts` (`AffectedEndpoint`).

### 2026-08-20 — [Context] Verify a graph feature against a REAL index, not just synthetic test graphs

Both blast-radius findings that mattered — the `file_rank` inner join wiping
callers, and barrel-file attribution noise — were invisible to a green test
suite and appeared within minutes of querying the running API against a
318-file index. Synthetic fixtures encode the shape you already imagined. For
anything reading `file_edges` / `file_rank` / `file_facts`, resync a real repo
and diff the response by hand before calling it done. Evidence:
`server/test/repo-intel-importers.it.test.ts` (green throughout both bugs).

### 2026-08-28 — [Context] Nothing on the review path checks out the PR head — project-context reads depend on that

`SimpleGitClient.readFile` reads the clone's WORKING TREE, and no code on the
review path ever moves it off the default branch: `fetchPullHead` only creates a
local `pr-<n>` ref (`:72`), `diff()` works from `base...head` refs (`:94`), and
`sync()` is `reset --hard origin/<branch>` (`:77`). That accident of design is
now load-bearing: it is what makes attached project-context documents
trustworthy, because a PR cannot rewrite the rules it is judged by inside its own
diff. Anyone introducing a `git checkout` of the PR head here must re-pin the
project-context read to the default branch explicitly, or the guarantee inverts
silently with no test failing. Evidence: `server/src/adapters/git/simple-git.ts:72-88`,
`server/src/modules/reviews/run-executor.ts` (`buildSpecDocs` docblock).

### 2026-08-28 — [Context] `trace-builder.ts` is NOT on the studio review path

`buildRunTrace` / `BuildTraceInput` (`server/src/platform/trace-builder.ts:51`)
exist for the A5 / CI-runner path. `ReviewRunExecutor` never calls them — it
hand-builds its `RunTrace` object literals, twice: once on success
(`run-executor.ts:325`) and once on the failure path (`:685`). A trace field
added only to `BuildTraceInput` therefore never appears in a studio run's trace,
and a field added to only ONE of the two literals silently vanishes from failed
runs. Any new trace field is a three-place edit. Evidence:
`server/src/platform/trace-builder.ts:45`, `server/src/modules/reviews/run-executor.ts:370`, `:695`.

### 2026-08-28 — [Context] The configured context roots gate DISCOVERY only, not attachment or preview

`DEVDIGEST_CONTEXT_ROOTS` decides which directories the discovery walk descends
into, and `documentType` uses the same list — but neither `readDocument`
(`service.ts:104`) nor `setAttachments` (`:156`) checks it. Both gate on
`safeContextPath`, which enforces clone containment and a `.md` extension and
nothing more. So any `.md` inside the clone can be previewed or attached by path
even though the listing never offers it, and such an attachment renders with a
null type. This is not a privilege boundary — the caller already owns the repo —
but do not read the roots as a security control. Evidence:
`server/src/modules/context/service.ts:43-58`, `:104`, `:156`.

### 2026-08-30 — [Decision] Eval runs are stored apart from `agent_runs`, on purpose

The eval pipeline (SPEC-03) writes `eval_run_batches` / `eval_runs` and never a
row in `agent_runs`. `agent_runs` is the observability record of *real PR
reviews* and feeds the run-cost rollup and the per-agent accept-rate stats, so
synthetic replays landing there would silently corrupt both. The accepted cost is
that eval spend is invisible to every existing cost surface — a future "total
spend" view has to union the two deliberately, not by accident.
Evidence: `server/src/db/schema/eval.ts` (`evalRunBatches` docblock),
`server/test/eval.it.test.ts` (asserts no `agent_runs` row is written by a batch).

### 2026-08-30 — [Decision] A batch aggregates by summing counters, never by averaging per-case rates

`eval_runs` persists raw `tp/fp/fn/kept/dropped` alongside the three rates
precisely so the batch row can be re-derived and audited later. Averaging the
per-case rates instead weights a one-target case the same as a five-target one,
so the aggregate would move when the case SET changed rather than when the agent
did. Evidence: `server/src/modules/eval/scoring.ts` (`aggregateBatch`),
`server/test/eval-scoring.test.ts` ("sums counters rather than averaging per-case rates").

## Tool & Library Notes

### 2026-07-20 — [Context] `getConventionSamples` returns file PATHS, not code

Despite the name, it is a one-line wrapper over `getTopFilesByRank` and resolves
to `Promise<string[]>` — top-ranked paths with tests/configs/migrations filtered
out. Any consumer that wants actual source must read each path off
`repos.clonePath` itself (`readFile(join(clonePath, file)).catch(() => null)`),
and must number the lines before showing them to a model, or the model cannot
cite a real `evidence.line`. It also returns `[]` — not an error — when
`repoIntelEnabled` is false or the repo was never indexed, so an empty result
means "no index", not "no conventions". Evidence:
`server/src/modules/repo-intel/service.ts:630`,
`server/src/modules/conventions/service.ts`.

### 2026-07-19 — [Decision] Skill versions snapshot the body ONLY, unlike agent versions

`agent_versions.config_json` captures the whole agent config, so `isConfigChange` bumps the version on any field but `enabled`. `skill_versions` has exactly one payload column (`body`), so `modules/skills/helpers.ts:isBodyChange` bumps only on a changed body — a rename, description/type edit, or `enabled` toggle leaves `skills.version` and the history untouched. Copying the agents rule verbatim would fill the history with snapshots whose bodies are byte-identical. Evidence: `server/src/modules/skills/repository.ts`, `server/src/db/schema/skills.ts:23`.

### 2026-07-19 — [Context] File uploads arrive as base64 JSON, not multipart — and need a per-route `bodyLimit`

`server/package.json` carries no `@fastify/multipart`, and the skills importer deliberately doesn't add one: the client base64-encodes the file into `{ filename, content_base64 }` so the Zod route-validation convention (`fastify-type-provider-zod`) still applies to an upload. The catch is `app.ts:49` sets a global `bodyLimit: 1_048_576`, which a base64-encoded archive (~4/3 expansion) exceeds almost immediately. Fastify accepts `bodyLimit` as a per-route option, so raise it on that route alone rather than widening the app default. Evidence: `server/src/modules/skills/routes.ts`, `server/src/modules/skills/constants.ts`.

### 2026-08-13 — [Context] A `Date` bound into a raw `sql` template fails to encode on postgres-js

`db.execute(sql\`… WHERE ran_at >= ${since}\`)` with a JS `Date` throws `The
"string" argument must be of type string or an instance of Buffer or
ArrayBuffer. Received an instance of Date`, and the route surfaces it as a bare
500. The query builder converts `Date` fine — this bites only on the raw `sql`
path. Bind `since.toISOString()` with an explicit `::timestamptz` cast instead.
Worth knowing because the failure is at execution time, not typecheck time:
`tsc` is perfectly happy with the `Date`. Evidence:
`server/src/modules/reviews/repository/skill-stats.repo.ts`.

### 2026-08-22 — [Context] `MockLLMProvider` cannot be constructed as `'openrouter'` — inject it by KEY instead

Following the 2026-08-11 rule above ("inject EVERY provider the path can
reach") runs straight into a wall: `MockLLMProvider`'s constructor accepts only
`'openai' | 'anthropic'` (`src/adapters/mocks.ts:62-63`), so
`new MockLLMProvider('openrouter')` does not compile — even though
`LLMProvider.id` includes it and `container.llm('openrouter')` is a real path.

Do not widen the shared mock for this. `Container.llm(id)` resolves an override
by KEY and never inspects `provider.id`:

    const injected = this.overrides.llm?.[id];
    if (injected) return injected;

So the `openrouter` slot takes an openai-flavoured mock and everything works —
the id field is only ever read by code that builds a real provider. Keeping the
fix at the call site is what holds the blast radius of a test-only change to
the test file.

Useful corollary for asserting a route makes NO model call: `MockLLMProvider`
records every invocation in a public `calls` array, so `expect(mock.calls)
.toEqual([])` is the assertion, and runtime is the cross-check — per the
2026-08-11 entry, a leak to the real network shows up as seconds, not as a
failed expectation. Evidence: `server/src/platform/container.ts:171`,
`server/test/smart-diff.it.test.ts`.

### 2026-08-30 — [Context] A route-level Zod schema returns 422 before a service ever throws its own 400

`fastify-type-provider-zod` validates `body`/`querystring` before the handler
runs, so a service-layer `ValidationError` (422) or `AppError(..., 400)` guarding
the same shape is unreachable from the wire and only fires for internal callers.
An integration test asserting the service's status code will fail against the
route's. Keep both — the service guard still protects non-HTTP callers — but
assert the route's code in route tests.
Evidence: `server/src/modules/eval/routes.ts` (`ExpectationBody`, `targets.min(1)`),
`server/test/eval.it.test.ts` ("rejects an expectation with no targets").

## Recurring Errors & Fixes

### 2026-08-28 — [Pitfall] The global rate limit is sized for the internet, but the caller is one browser tab

`app.ts` registered `@fastify/rate-limit` at a flat `max: 120` per minute. That
budget is PER IP and the entire studio is a single localhost IP driven by one
person, so it is really a cap on the app's own UI. The client's pollers
(repo-intel status every 1.5 s while indexing, the two runs pollers every 4 s
during a review) spend ~70/min before anyone clicks anything, and ordinary
editing then got `429`. Now `DEVDIGEST_RATE_LIMIT_MAX` (default 600) — but the
durable lesson is that a per-IP limit in a local-first single-user tool has to
be budgeted against the UI's own background traffic, not against an imagined
attacker.

Second half of the same bug: the error handler had no branch for Fastify-native
errors, so a 429 fell through the generic tail and was logged at `error` as if
the server had broken and returned as `code: 'internal_error'`, with the retry
delay available only as prose inside the message. The limiter has already set
`retry-after` on the reply by the time the handler runs, so read it there and
return it as a number — `Math.ceil(ttl / 1000)`, i.e. SECONDS, not ms
(`@fastify/rate-limit` 11.0.0, index.js:257). Note the limiter is disabled under
`NODE_ENV=test`, so a test for this has to build the app as `development`.
Evidence: `server/src/app.ts`, `server/test/routes-smoke.test.ts`.

### 2026-06-27 — [Context] Re-seeding won't refresh PR-level demo data if the PR row already exists

`seed.ts` wraps the review + findings insert in `if (!pr)` (`server/src/db/seed.ts:98`). If the PR was already seeded and then an agent run added new reviews, `pnpm db:seed` silently skips the block. To fully reset: `DELETE FROM repos WHERE full_name = 'acme/payments-api'` (cascades to PRs, reviews, findings), then `pnpm db:seed`.

### 2026-06-27 — [Context] `deriveReviewStatus` returns "reviewed" once `last_reviewed_sha = head_sha`

Running an agent review sets `pull_requests.last_reviewed_sha` to the current `head_sha`, permanently overriding a seeded "needs_review" state. To restore "needs_review" without wiping reviews: `UPDATE pull_requests SET last_reviewed_sha = NULL WHERE number = 482`. Without this reset, re-seeding still shows the PR as "Reviewed" because the status is derived at query time, not stored. Evidence: `server/src/modules/pulls/status.ts`, `server/src/modules/pulls/routes.ts:173`.

### 2026-07-19 — [Context] `skills` has no unique index on `(workspace_id, name)` — seed with select-then-insert

Unlike tables whose composite PK makes `onConflictDoNothing` sufficient
(`agent_skills`, `skill_versions`), `skills` has only a `uuid` primary key
(`server/src/db/schema/skills.ts:6`), so a bare `onConflictDoNothing` never
conflicts and a re-run inserts a duplicate row per skill. Seeding it idempotently
requires select-by-`(workspace_id, name)`-then-insert. This compounds the
2026-06-27 note above: the skills block must also sit OUTSIDE the `if (!pr)`
guard, or an existing PR row skips it entirely. Evidence:
`server/src/db/seed.ts`.

### 2026-08-11 — [Context] `.default([])` on a shared Zod contract field is a BREAKING change to `z.infer`

Adding `sources: z.array(IntentSource).default([])` to the `Intent` contract
broke `pnpm typecheck` at `pull.repo.ts` with `TS2741: Property 'sources' is
missing`, while every `.nullish()` sibling added in the same commit broke
nothing. `.default()` makes a key OPTIONAL on input but REQUIRED on output, so
every existing constructor of that type must be updated. Reach for `.nullish()`
unless a guaranteed non-null value is genuinely needed — and note this compounds
the vendored-copy rule, since the same edit lands in two places. Evidence:
`server/src/vendor/shared/contracts/brief.ts:53`.

### 2026-08-12 — [Context] The intent classifier answered in Chinese because no prompt rule pinned the output language

A user-reported "the UI is not in English" bug was NOT an i18n fault — every
static label was correct; the Chinese text was the model's own `intent` /
`in_scope` / `out_of_scope` strings, rendered verbatim. `review_intent` defaults
to `deepseek/deepseek-v4-flash`, and the classifier's `SYSTEM_PROMPT` never
stated an output language, so the model used its own. Fixed in the PROMPT rather
than by swapping the model, so it survives the next model change. Two follow-on
facts: `pr_intent` rows are persisted, so existing cards keep the old text until
"Re-detect" is pressed; and `SYSTEM_PROMPT` is a template literal, so a
markdown-style backtick in a new rule is a build error, not a formatting choice.
Evidence: `server/src/modules/intent/prompt.ts:46-49`,
`server/src/vendor/shared/contracts/platform.ts:51-57`.

### 2026-08-20 — [Context] Grep `test/` too before calling a shared-contract field safe to add

Adding a required `index` field to the `BlastRadius` contract was cleared by
grepping `server/src client/src` for `.parse()` call sites — and immediately
failed `test/contracts.test.ts`, which parses a literal fixture. Server contracts
are exercised by tests that no `src/` grep will find, and the blast route
declares no `response` schema, so `tsc` does NOT catch a missing key in a
`.parse()` argument either. Run the unit suite, not just `pnpm typecheck`, after
any shared-contract change. Complements the 2026-08-11 `.default([])` entry:
`.default()` shields a field from this (optional on input), a bare required
object field does not. Evidence: `server/test/contracts.test.ts:73`,
`server/src/vendor/shared/contracts/brief.ts:86-118`.


## Session Notes

### 2026-08-11 — Intent Layer: a cheap classifier call before the review

Added `modules/intent` (`GET /pulls/:id/intent`, `POST /pulls/:id/intent/detect`)
on the previously-dead `pr_intent` table, plus `reviewer-core/src/scope.ts`. A
Flash-class model classifies the PR from title/body/linked issue/plan doc/file
list **with hunk headers but no diff bodies**, and `ReviewRunExecutor` calls
`ensureFresh` once per review round (best-effort; a classifier failure logs and
the prompt reverts to its pre-intent shape byte-for-byte). Three decisions worth
keeping: the source ledger is recorded by the SERVER (`used`/`missing` + reason)
so an unreachable link is reported rather than invented; confidence is computed
from that ledger with the model's self-reported number able only to LOWER it;
and the scope filter is pure code with a hard CRITICAL/security/bug escape
hatch, because the scope list originates in attacker-controlled PR text.
`safeRepoRelativePath` gates every clone read — `SimpleGitClient.readFile` joins
onto the clone dir with no containment check of its own. Evidence:
`server/src/modules/intent/helpers.ts`, `server/test/intent.it.test.ts`.

### 2026-06-27 — Added per-severity findings counts to PR list endpoint

Extended `GET /repos/:id/pulls` to include `findings_critical`, `findings_warning`, `findings_suggestion` from the latest review per PR. Required a subquery joining `reviews → findings` grouped by severity. Both vendor copies (`server/src/vendor/shared/contracts/platform.ts` and `client/src/vendor/shared/contracts/platform.ts`) must be updated in sync — they are committed copies with no automated sync. New fields use `.nullish()` (consistent with `score`, `cost_usd`) so the detail route can omit them without breaking Zod serialization. Evidence: `server/src/modules/pulls/routes.ts:98`.

### 2026-07-20 — Conventions extractor: model proposes, code decides

Added `modules/conventions` (`GET /repos/:id/conventions`, `POST
/repos/:id/conventions/extract`, `PATCH /conventions/:id`) on the pre-existing
`conventions` table, migrated from `accepted` (boolean) to a three-state
`status` plus `category`, `evidence_line`, `created_at`. The extractor samples
top-ranked files, reads them off the clone, asks a cheap model for unwritten
house-rules, then re-checks every candidate against the source
(file sampled? line in range? snippet matches, whitespace-normalized, within a
±3-line window?) and drops the ones that fail before anything is persisted. Two
live runs on `Sashanikitenkova/dev-digest` showed the gate is load-bearing and
not merely strict: one kept 2 of 7, another kept 10 of 10. The route returns
`{proposed, kept, dropped}` so a run where the model invented everything cannot
render as a successful empty scan. Evidence:
`server/src/modules/conventions/helpers.ts`, `test/conventions-grounding.test.ts`.

### 2026-08-29 — [Pitfall] Reasoning tokens come out of `max_tokens`, so a completion cap sized for the answer returns NOTHING

The PR brief shipped with `BRIEF_MAX_COMPLETION_TOKENS = 1_200`, chosen as "the
size of a brief". Every generation failed in the studio with a 502 reading
*"Check the provider is reachable and the model supports structured outputs"* —
and the provider was reachable, and the model does support them.

On a reasoning model the reasoning tokens are drawn from the same `max_tokens`
budget, **before** any content. Measured live against
`openrouter/deepseek-v4-pro` with the feature's real schema and a 40-file
prompt:

| `max_tokens` | `finish_reason` | reasoning | outcome |
|---|---|---|---|
| 1 200 | `length` | 1 200 / 1 200 | empty content, failed 3/3 |
| 4 000 | `stop` | 0 | parsed, $0.0052 |

`deepseek-v4-flash` behaves the same (1 200 fails 3/3; at 4 000 it spends 1 430
reasoning of 2 938 total). OpenRouter's `reasoning: {exclude: true}` only HIDES
the tokens — it still burned 929 and still failed — and `reasoning: {effort:
'low'}` merely reduces them to 511, which is still not enough room for the
answer.

Three things make this hard to see:

1. **It never looks like truncation.** Empty content goes into
   `parseWithRepair`, fails, gets reprompted `maxRetries` times, and finally
   throws *"failed schema validation"* — so it reads as "this model can't do
   structured output", pointing at the provider instead of at our own cap.
2. **Every mocked test passes straight through it.** `MockLLMProvider` returns
   a fixture and consumes no tokens, so none of the 88 tests written for this
   feature — unit, integration against real Postgres, or client — could observe
   a completion cap being exhausted. The one check that catches it is a real
   call.
3. **Each failed attempt still costs money.** Three retries × a full cap of
   reasoning tokens, with nothing to show.

`reviewer-core/src/llm/openrouter.ts` now reports `finish_reason`, whether the
content was empty, the reasoning-token count and `max_tokens` when it gives up,
and names the cap when `finish_reason` is `length` — our own diagnosis, carrying
no provider response body, so a caller forbidden from echoing one can still
surface it. Evidence: `server/src/modules/brief/constants.ts`,
`reviewer-core/src/llm/openrouter.ts`, `reviewer-core/test/openrouter-structured.test.ts`,
`server/test/brief-budget.test.ts`.

**This likely explains the 2026-07-20 open question below** about a review
taking 13m40s with skill blocks added and 55s without, on
`openrouter/deepseek-v4-flash` — now known to be a reasoning model. A bigger
structured-output prompt means more reasoning; if a response gets truncated
mid-reasoning the repair loop reprompts with an even longer message and reasons
again. Worth re-timing that case with the reasoning-token counter now that we
log it.

### 2026-08-30 — Seeded findings are worthless unless `pr_files.patch` is populated

Building the L06 eval pipeline surfaced that the demo PR had `pr_files` rows with
a null `patch` and a review with a null `agent_id`. With no clone on disk
`diffFromPrFiles` then reconstructs an empty diff, the grounding gate drops every
finding, and nothing downstream can cite a real line — the failure is completely
silent, with no error anywhere. The seed now ships real hunks whose line numbers
the seeded findings fall inside, and a unit test runs the seeded findings through
`groundFindings` so editing a patch without moving the findings fails in CI
instead of in a demo. Evidence: `server/src/db/seed.ts` (`DEMO_PATCHES`,
`DEMO_FINDINGS`), `server/test/eval-seed-fixtures.test.ts`.

### 2026-08-30 — Seed top-ups must key on identity, not on "is the table empty"

The first version of the eval-dataset seed inserted its findings only when the
demo review had none. That is correct on a fresh database and a no-op on every
existing one — which already carried the original two undecided findings, so a
developer re-seeding would have been left permanently short of the decided
findings the eval set is built from. Topping up by TITLE makes it idempotent in
both directions. This is the same class of bug as the `if (!pr)` guard noted in
the seed's own comment, one level down. Evidence: `server/src/db/seed.ts`
(the `seenTitles` / `missing` top-up).

## Open Questions

### 2026-07-20 — Why did the skills-on review run take 13 minutes against 55 seconds without?

Same PR, same agent, same `openrouter/deepseek-v4-flash`; the only difference
was ~4 skill blocks added to the prompt (2529 prompt tokens → noticeably more).
Run A finished in ~55s, run B took 13m40s wall clock and still produced a
correct, fully grounded result. A direct OpenRouter call was 1.0s at the same
time, so the provider was healthy. `openai.ts` uses a 60s per-attempt timeout
with `maxRetries` 2, which should cap a stalled call well under that — so
either the retry accounting is not behaving as read, or this reasoning model
streams for far longer on bigger structured-output prompts. Worth timing
properly before anyone trusts review latency numbers. Evidence:
`server/src/adapters/llm/openai.ts:15`, `reviewer-core/src/review/run.ts:174`.
