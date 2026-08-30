---
name: workflow-retro
description: "Reports how a multi-agent run actually went: token spend, the agent roster and launch order, where work was duplicated or re-derived, what each agent missed, and what to brief differently next time — then appends the durable insights to docs/retro/ledger.md. TRIGGER only on an explicit /workflow-retro typed by the user; this reads session telemetry, is never auto-delegated, and is never chained onto the end of another command. SKIP when the session dispatched no subagents: say so and stop without writing."
user-invocable: true
---

# Workflow Retro

Reports on how a multi-agent run actually went — what it cost, which agents ran
in what order, what work got re-derived three times, and what to brief
differently next time. You are the **analyst**: this command dispatches no
agents, changes no code, and touches no agent or skill definition. It reads
what the session already produced.

Nothing else in this repo measures a run. `run-plan`'s `state.json` records
phase, iteration and open items but carries no timestamps, no token counts and
no model attribution, so this is the only place those questions get answered.

Two guides carry the detail: [`guides/telemetry.md`](guides/telemetry.md) — the
jq recipes and the traps that make them lie — and
[`guides/rubric.md`](guides/rubric.md) — what earns a place in the assessed
section and what evidence it needs.

## Hard rules

- **Manual only.** Run when the user types `/workflow-retro`. Never fire at the
  end of another command, never auto-delegate, never offer to "just also run
  the retro" as part of finishing something else.
- **Never `cat` a transcript.** They reach 7 MB. Deep mode uses jq aggregates
  and `.meta.json` sidecars only — otherwise the retro blows the context it is
  reporting on.
- **Measured and assessed never mix.** A number and an opinion in the same
  table is how a retro becomes fiction that reads like data.
- **No citation, no entry.** Every assessed claim needs a jq figure, a
  `path:line`, or a quoted line from an agent's report. This mirrors the
  grounding rule the review engine itself enforces.
- **Name the token definition.** Two different per-agent token numbers exist and
  they disagree by more than an order of magnitude (see below). State which one
  the report used; never put both in one table.
- **Writes exactly one file** — `docs/retro/ledger.md`, append-only. Never
  rewrite or delete a past entry.
- **Proposals are text.** Never edit `.claude/agents/*.md`, a `SKILL.md`, or
  anything else the retro recommends changing.
- **An empty result is a result.** A session with no subagents gets a report
  saying so, not a padded one.

## Arguments

```
/workflow-retro [deep] [<session-id>]
```

| Mode | Source | Use when |
|---|---|---|
| default (in-context) | The task notifications and agent reports already in this conversation | The run just happened in this session and the conversation still holds it |
| `deep` | The session JSONL transcripts, via jq | You need session-wide totals, model attribution, or duplication analysis — or the conversation was compacted |

A bare `<session-id>` analyses a past session; it implies `deep`, because a
past session's notifications are not in this context.

## Step 1 — Establish the session, and the mode's limits

Resolve the session id from the scratchpad path the harness provides
(`/private/tmp/claude-501/<project-slug>/<session-id>/scratchpad`). That is
exact. Falling back to the newest `.jsonl` by mtime picks the wrong session when
two run against one project — if you must fall back, say so in the report.

Then check the mode can actually answer:

- **In-context**: if you cannot find the task notifications in this
  conversation, the context was compacted. Say so and recommend `deep` — do not
  quietly report a short roster and let it read as a complete one.
- **Deep**: if `<session-id>/subagents/` does not exist, the session predates
  subagent transcripts (Claude Code 2.1.241 and earlier wrote none). Report the
  empty result.

State the mode and its blind spots at the top of the report. What each mode
cannot see is in [`guides/telemetry.md`](guides/telemetry.md).

## Step 2 — Part 1: Measured

Every number traceable to its source — a named notification or a named jq
expression over a named file. Recipes in
[`guides/telemetry.md`](guides/telemetry.md).

- **Agent roster** — type, description, launch time, tokens, tool calls,
  duration. In deep mode read it from the `.meta.json` sidecars, whose
  `toolUseId` joins to the parent's `Agent` tool_use: launch order comes out of
  metadata, never out of parsing prose.
- **Launch order and parallelism** — which spawns went out in one batch
  (launched seconds apart) versus serially. Report wall-clock against summed
  agent time as a ratio.
- **Session totals** (deep only) — split by `input` / `output` /
  `cache_read` / `cache_creation`. A single "tokens spent" headline misleads
  when cache reads are most of it, which they usually are.
- **Models and effort** (deep only), per request.
- **File overlap** (deep only) — files pulled by two or more agents. This is a
  measured fact; its interpretation belongs in Part 2.

**The trap that matters most.** Two per-agent token numbers exist:
the `<subagent_tokens>` in a task notification, and the deduped sum of that
agent's own transcript. On one measured run they were **144,170** and
**2,548,508** — ~18x apart, because the notification excludes cache reads.
In-context mode yields the first, deep mode the second. Label the column with
which one it is.

## Step 3 — Part 2: Assessed

Judgements, each carrying its evidence, in a section that cannot be mistaken
for Part 1. The bar and the evidence each kind of claim needs are in
[`guides/rubric.md`](guides/rubric.md). What belongs here:

- **Duplicated work** — grounded in the file-overlap figures, not impressions.
- **Difficulty** — proxied by tool calls, error results and retries, and
  reported *as a proxy*. Never "the agent struggled".
- **Misses and corrections** — an agent report that contradicts the prompt it
  was given, or that the main thread had to correct afterwards. Quote both
  sides. This usually indicts the brief, not the agent.
- **Blocking-question stops** — an agent that hit its gate is a signal about
  how it was briefed.
- **Report-skeleton conformance** — `.claude/agents/README.md` gives each agent
  a fixed output skeleton with a mandatory negative-space section. Whether each
  returned one is mechanically checkable.

Sections stay present when empty. A retro that reports only what it found is
indistinguishable from one that stopped looking.

## Step 4 — Part 3: Proposals

Each proposal names a target file, the rule or line it would change, and the
Part 1 or Part 2 evidence that motivates it. Address them: a proposal nobody
owns is a note. Ordered by the evidence behind them, strongest first.

Worth checking every run, because the data is already in hand:

- **Cost against gating role.** `docs/agent-prompts/choosing-a-model.md` states
  the doctrine — cost follows importance. An expensive agent that gates nothing
  is the finding.
- **Cost per outcome** — tokens per accepted finding, per closed plan item, per
  acceptance criterion. A total is not actionable; a ratio is.
- **Remediation-loop cost** — when `run-plan` ran, join its `state.json`
  (`closed` / `stillOpen` / `escalated`) to spend per iteration.
- **Parallelism left on the table** — agents run serially whose inputs did not
  depend on each other.
- **Cache efficiency** (deep only) — heavy `cache_creation` against light
  `cache_read` means context was rebuilt rather than reused.
- **Trend** — compare against prior entries in `docs/retro/ledger.md`.

**Deliberately not reported: dollar figures.** No cost data exists anywhere in
the session telemetry, and a hardcoded rate card would silently rot. Report
tokens, and say that is why there is no `$`.

## Step 5 — Append to the ledger

Append one entry to `docs/retro/ledger.md`, newest at the end. Read the file
first; create it with a title and a one-line explanation if absent.

Each entry is **discrete and self-contained** — readable on its own, without the
chat report it came from:

```
## YYYY-MM-DD — <what the run did>

**Mode:** in-context | deep · **Agents:** N (types) · **Tokens:** N (<which definition>)
**Wall-clock:** … · **Parallelism:** …

- **<Insight, as a falsifiable claim.>** Evidence: <jq figure, path:line, or quote>.
- **Proposal — `<target file>`:** <the change>. Because: <evidence>.
```

The full tables stay in chat. The ledger is the memory, not the transcript —
only what is worth reading months later goes in. Finding nothing worth keeping
is a correct outcome; write the metrics line and no bullets.

A conclusion that later proves wrong gets a **new** dated entry naming the one
it supersedes. Never edit the old entry.

## Report skeleton

```
## Mode              — in-context | deep · what this mode cannot see
## Session           — id, span, how it was resolved
## Measured          — roster, order, parallelism, totals, overlap
## Assessed          — judgements, each with its evidence
## Proposals         — target file · change · motivating evidence
## Ledger            — what was appended, or why nothing was
## Not analysed      — what this run could not determine, and why
```

`Assessed`, `Proposals` and `Not analysed` stay in the report even when empty.
