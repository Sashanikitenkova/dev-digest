# reviewer-core's LLM Port

`reviewer-core` is the purest domain core in this codebase — this guide covers how it stays pure and the one deliberate exception to that purity.

## `LLMProvider` as the only side-effect boundary

`reviewer-core/src/review/run.ts`'s `reviewPullRequest()` is the engine entry point. Its own doc comment states the boundary directly:

> "This is the pure core lifted out of the server's `ReviewService.runOneAgent`: assemble prompt → single-pass OR map-reduce per file → reduce → SHARED citation-grounding gate. It performs NO I/O beyond the injected LLM provider (no DB, GitHub, fs, memory retrieval, intent, or persistence) — those stay in the caller."

The `LLMProvider` interface (and `StructuredRequest`/`StructuredResult` types) is defined in `server/src/vendor/shared/adapters.ts`. `reviewPullRequest()` takes it as a parameter (`ReviewInput.llm: LLMProvider`) and does nothing impure beyond calling it. Anything the pipeline needs beyond that — skill bodies, memory items, spec chunks — arrives as already-resolved strings, per `ReviewInput`'s doc comments ("Resolved skill bodies (NOT slugs)").

## The mandatory grounding gate as a domain invariant

`reviewer-core/src/grounding.ts`'s `groundFindings()` enforces a business rule entirely inside the pure core, independent of which LLM produced the output:

> "A diff-finding is kept ONLY if its [start_line, end_line] range intersects a real hunk in the unified diff for the same file. Findings that fail are dropped (the model 'hallucinated' a location)."

`reviewer-core/CLAUDE.md` states this is non-negotiable: "Grounding is mandatory — never bypass `groundFindings()` or trust the model's self-reported score; the score is always recomputed from surviving findings." Any new code path that produces `Review`/`Finding` data must route through this gate.

## The `OpenRouterProvider` nuance

`reviewer-core/src/llm/openrouter.ts` is a *concrete* adapter — it imports the `openai` SDK directly — yet it physically lives inside the "pure" `reviewer-core` package. This looks like a violation of "adapters live outermost, never inside the domain package," but it's a deliberate, documented exception. Its own doc comment explains why:

> "The single OpenAI-compatible structured provider, owned by the engine because BOTH consumers need it: the CI runner (the GitHub Action runs reviewer-core directly) and the studio server's openrouter path. Centralizing it here means session grouping, the no-choices guard, request timeouts, and the parse-with-repair loop live in ONE place instead of being duplicated."

The purity guarantee is preserved because `OpenRouterProvider` is **constructed only at each consumer's composition root** — `server/src/platform/container.ts`'s `buildLlm()` does `new OpenRouterProvider(key, { estimateCost: ... })` — and never inside `prompt.ts`, `grounding.ts`, or `review/run.ts`. Those files only ever receive an already-constructed `LLMProvider` as a parameter. When reviewing `reviewer-core` code, don't flag `llm/openrouter.ts` itself as a boundary violation — flag any *other* file in the package that starts constructing providers or reading API keys directly.

## Good vs bad

**1 — where `LLMProvider` gets constructed**

- Good: `OpenRouterProvider` constructed exactly once, inside `container.ts`'s `buildLlm()`, then passed down as an interface-typed value into `reviewPullRequest({ ..., llm })`.
- Bad: `review/run.ts` or `prompt.ts` importing the `openai` SDK directly, or constructing an `OpenRouterProvider`/reading `process.env.OPENROUTER_API_KEY` internally instead of receiving `llm` as a parameter — exactly the violation `reviewer-core/src/index.ts`'s doc comment guards against ("the only side effect is an LLM call through an INJECTED LLMProvider").

**2 — bypassing the grounding gate**

- Good: `review/run.ts` always piping raw LLM findings through `groundFindings()` before returning a `Review`, per the mandatory gotcha in `reviewer-core/CLAUDE.md`.
- Bad: a new caller (e.g. a different review flow wired up in `server`) reading `StructuredResult.data.findings` directly off the `LLMProvider` response and persisting them without routing through `groundFindings()` — this reintroduces hallucinated line citations that the domain invariant exists specifically to prevent.
