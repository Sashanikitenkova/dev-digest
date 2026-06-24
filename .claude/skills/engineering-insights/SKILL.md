---
name: engineering-insights
description: "Captures non-obvious engineering knowledge — architectural decisions, implementation patterns, pitfalls, performance findings, debugging discoveries, framework-specific behavior, and integration constraints — into the right package's INSIGHTS.md so it survives past this session. Use AUTOMATICALLY the moment you discover something a future agent reading only the code would not figure out: a tool/library quirk, a bug whose root cause was non-obvious, a convention that diverges from the obvious default, or a decision made between real alternatives. Also invoke explicitly as /engineering-insights at the end of any session as a mandatory wrap-up review, even when nothing new turns up. Trigger terms: insight, gotcha, surprising, non-obvious, why does this, took a while to figure out, INSIGHTS.md, wrap up, end of session."
---

# Engineering Insights

Append durable, non-obvious knowledge to the right package's `INSIGHTS.md` —
**as you go**, the moment you find it, and again as a **mandatory
end-of-session review**. No hooks enforce this yet, so the discipline below
is the only thing making it reliable.

## 0. Read before you write — every mode

Before composing any entry, automatic or via explicit
`/engineering-insights`, read the full current target `INSIGHTS.md` first.
**Never overwrite or delete existing content.** Append only. If a past
entry turns out wrong, add a new dated entry that supersedes it — don't
edit or remove the original.

## 1. When to trigger

- **As you go** — the instant you hit something that passes the test below.
- **End of session** — always, not just for long sessions. Re-scan what
  happened and check each surprising thing against the test below. Finding
  nothing new is a correct outcome, not a failure — make no changes rather
  than padding the file.

## 2. The anti-vagueness test

*If this would be obvious to anyone who just read the code, don't write
it.*

- Bad: "Promises can be tricky."
- Good: "Using `Promise.all()` on the data ingestion pipeline times out
  after 30 items. Switch to `Promise.allSettled()` with batching (max 10
  at a time) for that module."

If you can't write the "good" version — concrete, falsifiable, tied to a
real file/line — don't write an entry.

## 3. Classify it (4 categories)

| Category | What it is | Goes in section |
|---|---|---|
| **Pattern** | An approach that works and is worth repeating | What Works |
| **Mistake** | An approach that looked right but failed, and why | What Doesn't Work |
| **Decision** | A choice between real alternatives + the reason | Codebase Patterns *or* Session Notes |
| **Context** | A codebase convention, tool/library quirk, or a recurring error+fix not obvious from reading the code alone | Codebase Patterns, Tool & Library Notes, *or* Recurring Errors & Fixes |

Covers: architectural decisions, implementation patterns, pitfalls,
performance findings, debugging discoveries, framework-specific behavior,
integration constraints. Anything that's a real discovery but doesn't fit
a fixed section, or a question you couldn't resolve, goes in **Open
Questions** instead of being forced into the wrong bucket.

## 4. Pick the target file

Insights live next to the code they're about — never a root-level file.

| You were working in... | Write to |
|---|---|
| `client/**` | `client/INSIGHTS.md` |
| `server/**` (including `server/src/modules/repo-intel/**`) | `server/INSIGHTS.md` |
| `reviewer-core/**` | `reviewer-core/INSIGHTS.md` |
| `e2e/**` | `e2e/INSIGHTS.md` |

`repo-intel` is a module *inside* `server`, not its own package — it has no
`INSIGHTS.md` of its own. If a session touches more than one package,
write a separate entry to each affected package's file — don't merge them.

## 5. Check for duplicates first

Before appending, scan the target section for a duplicate or near-duplicate
claim. If one already exists, don't repeat it.

## 6. Write the entry

Append under the matching section heading. Never insert mid-file or
reorder — always append at the end of the section.

```
### YYYY-MM-DD — [Category] One-line claim

<1–3 sentences of detail.> Evidence: `path/to/file.ts:123`.
```

- **Date** — always, so entries can be aged and pruned.
- **Category** — `[Pattern]`, `[Mistake]`, `[Decision]`, or `[Context]`.
- **Claim** — specific and falsifiable, not a vague gesture at a topic.
- **Evidence** — a real `file:line` (or `file:start-end`) the claim is
  grounded in. No citation, no entry — this mirrors the grounding
  discipline the review engine itself enforces
  (`reviewer-core/src/grounding.ts`): unanchored findings don't survive,
  and neither should unanchored insights.

## 7. Append-only — never silently rewrite

If a past entry turns out wrong or outdated, do **not** edit or delete it.
Append a new dated entry that says so explicitly:

```
### 2026-06-22 — [Decision] Supersedes 2026-05-01 entry on retry batching

The earlier note said batches of 10; load testing showed 25 is the actual
safe ceiling. Evidence: `server/src/adapters/llm/openrouter.ts:88`.
```

## 8. The 7 fixed sections

Every `INSIGHTS.md` has these sections, in this order, after the intro
blurb. Don't add new sections or rename these.

1. **What Works** — Patterns worth repeating.
2. **What Doesn't Work** — Mistakes and antipatterns. The most commonly
   skipped section and the most valuable one — never omit it just because
   nothing comes to mind; if a fix took more than one attempt, the failed
   attempt belongs here too.
3. **Codebase Patterns** — Conventions and architecture decisions specific
   to this package that aren't obvious from the code alone.
4. **Tool & Library Notes** — Quirks and useful behaviors discovered about
   a dependency, framework, or external tool used in this package.
5. **Recurring Errors & Fixes** — An error you'd hit again, and the fix.
6. **Session Notes** — Timestamped, brief summaries of what a session
   accomplished, for anything dated that doesn't cleanly fit 1–5.
7. **Open Questions** — Unresolved, worth a future session's attention.

## 9. Keep the file lean

Signal drops once a file passes roughly 200 entries. If a section is
clearly bloated, or you spot 3+ entries saying near the same thing, append
one consolidated entry summarizing them and note which dated entries it
replaces — don't delete the originals, and don't let this block your
current capture.
