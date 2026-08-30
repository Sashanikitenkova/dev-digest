# Rubric — what earns a place in the assessed section

Part 1 reports numbers. This guide governs Part 2 and Part 3, where the retro
starts having opinions. The whole risk of this skill lives here: a confident
sentence about an agent's "struggle" sitting next to a real token count reads
as measurement, and a reader cannot tell them apart unless you make it
impossible to confuse them.

## The bar

**If it would be obvious to anyone who read the report, don't write it.**

Bad — unfalsifiable, no evidence, tells nobody anything:

> The Explore agents were effective and returned useful information.

Good — specific, falsifiable, tied to a figure and a quote:

> Three agents each read `CLAUDE.md` and two each read
> `reviewer-core/src/prompt.ts`. Evidence: file-overlap pass, 4 and 3 readers
> respectively. The second and third briefs could have carried the first's
> findings instead of re-deriving them.

If you cannot write the good version, do not write an entry.

## Evidence — one of these, or it does not ship

| Kind | Looks like |
|---|---|
| A figure | A number from a named Part 1 recipe: "42 tool calls", "2,548,508 tokens (deep definition)" |
| A `path:line` | A file the retro actually read this run |
| A quote | A line from an agent's returned report, or from the prompt it was given |

An inference chaining two pieces of evidence is fine — say it is an inference
and show both links. An inference with no links is an opinion, and opinions are
what this section exists to keep out.

## Claim kinds and what each one needs

| Claim | Required evidence | Never write |
|---|---|---|
| Work was duplicated | The overlap figure, with reader count per file | "The agents overlapped a lot" |
| An agent had difficulty | Tool-call count, error results, or retries — **stated as a proxy** | "The agent struggled" / "got confused" |
| An agent missed something | The gap, plus what the main thread had to do afterwards | "It should have caught X" with no trace of X being caught later |
| The brief was wrong | The prompt line and the agent's contradicting line, both quoted | "Better prompting would help" |
| An agent stopped at its gate | The blocking questions it returned, and whether they were answerable from the brief | Treating any gate stop as a failure — a correct stop is the agent working |
| Skeleton non-conformance | The section named in `.claude/agents/README.md` and its absence from the report | Flagging a missing section for an agent whose definition does not require it |
| Cost was misallocated | Tokens per agent against that agent's gating role | "It was expensive" with no role comparison |

## Difficulty is a proxy, and proxies get labelled

Tool calls, errors and retries are the only difficulty signal available. They
are genuinely ambiguous: a high count can mean a hard problem, a vague brief, or
a thorough agent doing exactly what it should. Report the number and the
candidate readings; do not collapse them into a verdict about the agent.

An error count of zero is common and truthful. Do not treat it as a broken
measurement and go hunting for something to say.

## Blame the brief before the agent

When an agent returned something wrong or incomplete, check the prompt it was
given before concluding anything about the agent. The dispatching brief is
written by the orchestrating session and is the most common defect — and the
one the user can actually fix next run.

The strongest single finding this skill can produce is an agent report that
**opens by contradicting its own prompt**: it means the dispatcher stated
something false as fact, and the agent had to spend its opening tokens undoing
it. Quote both sides when you find one.

## What never goes in Part 2

- Praise. "The pipeline worked well" is not a finding and costs a reader time.
- Restated Part 1 numbers with an adjective attached.
- Advice that does not depend on this run — anything you could have written
  before it started.
- Anything about an agent's internal state. You observed tool calls and text,
  not effort or intent.
- Counts padded toward a target. There is no minimum; zero assessed findings
  with a full Part 1 is a good report.

## Proposals

A proposal is a Part 2 finding plus an address. Each needs:

1. **A target file** — `.claude/agents/<name>.md`, a `SKILL.md`, or "the
   dispatching brief" when the fix belongs to how the session drives agents.
2. **The change** — concretely what would differ, not "consider improving".
3. **The motivating evidence**, carried down from Part 1 or Part 2.

Order by evidence strength, not by how interesting the idea is. A proposal
backed by one ambiguous proxy goes below one backed by a measured overlap.

Two standing cautions:

- **One run is a sample of one.** A proposal that would change a rule for every
  future run needs either a strong measurement or a matching entry in a previous
  ledger entry. Say which of the two you have; when it is neither, mark the
  proposal as provisional and say what a second run would confirm.
- **The retro never applies its own proposals.** Writing to
  `.claude/agents/*.md` would let one run's noise rewrite the infrastructure
  every future run depends on. Propose; the user decides.

## Ledger entries

The ledger keeps what is worth reading months later. An entry earns its place
if it would change how someone dispatches the *next* workflow. Metrics lines
always go in — they are what makes trend comparison possible. Findings and
proposals go in selectively.

Finding nothing worth keeping is correct: write the metrics line and no
bullets. A padded ledger stops being read, and an unread ledger records
nothing.
