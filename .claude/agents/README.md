# Agents

Project subagents for DevDigest. Canonical location is `.claude/agents/`; each
agent is one markdown file with YAML frontmatter, shared with the team via
version control.

Agents are invoked through the Task tool — either delegated automatically (Claude
matches the request against the `description` field) or named explicitly. Each one
runs in a **fresh, isolated context**: it does not see the conversation that
spawned it, the files already read, or the skills already loaded. It receives its
own system prompt, basic environment details, and the `CLAUDE.md` hierarchy —
**not** `INSIGHTS.md`, which is why every agent below that needs it loads it
explicitly.

Built-in agents (`Explore`, `Plan`, `general-purpose`) remain available and are
not redefined here.

## Catalog

| Agent | Model | Write access | Status | Role |
|---|---|---|---|---|
| [researcher](researcher.md) | `sonnet` | none | active | Answers a specific question from the codebase or the web; returns a sourced report |
| [spec-creator](spec-creator.md) | `opus` | `specs/` only | active | Turns a request plus its design sources into one SPEC-NN file — EARS criteria, design review, module map |
| [implementation-planner](implementation-planner.md) | `opus` | none | active | Reviews the existing requirements, then turns a request into a constraint-checked Implementation Plan |
| [implementer](implementer.md) | `opus` | source + tests | active | Executes an approved plan (or a Remediation Plan) across frontend and backend; writes tests only in single-agent mode |
| [test-writer](test-writer.md) | `sonnet` | tests only | active | Writes and extends client, server, and reviewer-core tests to each package's own idioms, then runs the suite |
| [architecture-reviewer](architecture-reviewer.md) | `sonnet` | none | active | Read-only boundary review; severity-normalized findings, each grounded in a `path:line` and a confidence score |
| [plan-verifier](plan-verifier.md) | `opus` | none | active | Checks finished work against an Implementation Plan item by item and returns a verdict table |
| [doc-writer](doc-writer.md) | `opus` | `docs/` only | active | Turns a plan or a shipped feature into documentation, routed to the right place under `docs/` |

## Responsibilities and artifacts

### researcher

| | |
|---|---|
| **Owns** | Finding and reporting facts — in-repo (Mode A) or external/web (Mode B) |
| **Never** | Writes, edits, implements, or proposes code changes |
| **Tools** | `Read, Grep, Glob, Bash, WebSearch, WebFetch` |
| **Bash contract** | Read-only inspection only (`git log`, `git blame`, `git show`, `rg`, `ls`, `find`) |
| **Input** | A specific, answerable question plus an explicit or obvious mode |
| **Output** | `Conclusions` · `Evidence` (`path:line` or numbered source) · `References` · `Could not find` |
| **Gate** | Asks 1–3 clarifying questions and stops when the question is vague, unbounded, or mode-ambiguous |

### spec-creator

| | |
|---|---|
| **Owns** | Writing down **what** should be built — the problem, EARS acceptance criteria, edge cases, a design review of what the mockups leave undefined, and a module-interaction map |
| **Never** | Plans or implements (no file lists, build order, or code); writes outside `specs/`; edits an `approved`/`implemented` spec; sets `Status: approved`; fans out to other agents |
| **Tools** | `Read, Grep, Glob, Write, Edit, Bash, Skill` — no `Agent`, no web |
| **Write scope** | `specs/**` and `<pkg>/specs/**` only — prompt-enforced, like `doc-writer`'s `docs/` |
| **Preloads** | `skills: mermaid-diagram`; loads `security` / `onion-architecture` / `frontend-architecture` on trigger, and never the implementation skills |
| **Input** | A feature request plus whatever design sources the user supplies — description, screenshot, Figma export, existing code, reference repo |
| **Output** | One `SPEC-NN-YYYY-MM-DD-<slug>.md` built from [`specs/TEMPLATE.md`](../../specs/TEMPLATE.md), an updated folder index, and a report: `Spec written` · `Scope` · `Context read` · `Design sources used` · `Design findings` · `Self-check` · `Blocking questions` · `Research requests` · `Open questions` · `Not done` |
| **Gate** | Returns 1–5 blocking questions **and** any research requests together, and stops without writing. The main session answers and dispatches `researcher`, then re-invokes |

It cannot fan out — subagents do not nest — so research it needs is *requested*
as specific, answerable questions with a mode, and the main session runs
`researcher` on them, in parallel where there is more than one.

Zero design findings is a valid result. The section is evidence-gated precisely
because a reviewer told to find gaps will find them.

### implementation-planner

| | |
|---|---|
| **Owns** | Reviewing the requirements that exist, scoping a change by package, loading the governing rules, settling the execution mode with the user, and designing an executable plan |
| **Never** | Authors specs, acceptance criteria, or requirements documents (`<pkg>/specs/**` is read-only input); edits files, runs the app or tests, performs review (`/pr-self-review`, `/security-review`, `/code-review`), or fans out to other agents |
| **Tools** | `Read, Grep, Glob, Bash, Skill, AskUserQuestion` — no `Write`/`Edit`, no `Agent`, no web |
| **Preloads** | `skills: onion-architecture, frontend-architecture` |
| **Input** | A feature or change request, plus whatever written requirements exist under `<pkg>/specs/**` |
| **Output** | An Implementation Plan returned as its report: `Context` · `Requirements review` · `Scope` · `Execution mode` · `Constraints in force` · `Skills for the implementer` · `Reuse` · `Steps` · `Tests` · **`Traceability`** · `Verification` · `Risks & open questions` · `Out of scope` |
| **Gates** | Two. **Requirements** — asks 1–3 questions and stops when scope, acceptance criteria, or the frontend/backend split are undefined. **Execution mode** — after scoping, asks whether the work runs multi-agent or single-agent, with a stated recommendation. Both use `AskUserQuestion`, falling back to returning the questions as the report |

It reports on requirements; it does not write them. Missing or untestable
criteria come back as findings and recommendations in `Requirements review`,
never as an invented requirement planned against as though it had been given.

`Traceability` is what closes the spec-driven loop: one row per `AC-n` mapping
the criterion to the plan step that implements it, the test that proves it, and
the spec's verification hint. `plan-verifier` reads that section to return a
verdict **per acceptance criterion**, not merely per plan step — without it the
pipeline can confirm the builder followed instructions but never that the
feature is what was specified.

It reads `guides/skill-matrix.md` to derive the rulebook, but opens a full
`SKILL.md` only to settle a specific conflict, and writes the binding rules into
`Constraints in force` as short sourced quotes. Reading five matched skills here
and having the implementer load the same five again pays for identical content
twice — `react-testing-library` alone is 19 KB.

The plan is a **handoff artifact**, written for an agent with no access to the
originating conversation — no "as discussed above", every step names its files.
In multi-agent mode each step group also names its owning agent, because every
agent downstream starts in a fresh context.

### implementer

| | |
|---|---|
| **Owns** | Executing an approved plan, and running a narrow gate over the packages it touched |
| **Never** | Re-plans, fixes adjacent issues, self-grades, writes `INSIGHTS.md`, changes git state, runs migrations/seeds/installs, touches Docker, or (in multi-agent mode) writes tests |
| **Tools** | `Read, Grep, Glob, Edit, Write, Bash, Skill, TodoWrite` — no `Agent`, no web. `maxTurns: 120` as a backstop, not a target |
| **Blast radius** | Source and tests only. Migrations are written but left unapplied and escalated |
| **Input** | The full text of an approved Implementation Plan — **or** a Remediation Plan: numbered review findings, each with a `path:line`, which it treats as plan steps |
| **Output** | An Implementation Report: `Summary` · `Changes` · `Plan step status` · `Skills applied` · `Verification` · `Deviations` · `Not done / out of scope` · `Insight candidates` |
| **Verification** | `TESTING.md` §Running locally is the command source. `typecheck` plus tests **filtered to the changed files**, run **once**, after the last step; at most two fix attempts per failing gate. The full suite belongs to `test-writer` and `plan-verifier` |

It reports **verification facts**, never a verdict — architecture and security
judgment belong to separate review agents and the `pr-self-review` gate.

A **Remediation Plan** is the mechanism that closes review findings. Without it
the loop has no owner: `architecture-reviewer` and `test-writer` can only
report, and a plan-bounded implementer would rightly refuse to fix anything the
original plan never mentioned. "No scope creep" then means nothing *beyond* the
listed findings — not permission to decline them.

### test-writer

| | |
|---|---|
| **Owns** | Writing and extending tests across `client/`, `server/`, `reviewer-core/`, and `mcp/`, to each package's own idioms. In multi-agent mode it is the **sole** owner of tests |
| **Never** | Edits non-test source, makes a red test green by changing the code under test, `it.skip`s a failing test, writes `INSIGHTS.md`, runs migrations/seeds/installs, touches Docker, or authors `e2e/` flows |
| **Tools** | `Read, Grep, Glob, Edit, Write, Bash, Skill, TodoWrite` — no `Agent`, no web |
| **Blast radius** | Test files only — `client/src/**/*.test.tsx`, `server/test/**`, `reviewer-core/test/**`. Enforced by prompt, not by the tool layer |
| **Skills** | On demand, not preloaded — `react-testing-library` for `client/`, `onion-architecture` for ring/placement questions. There is **no** server-testing skill; `TESTING.md` plus the `server/test/` corpus is the pattern source |
| **Input** | A behaviour or surface to cover, and whether DB-backed coverage is wanted |
| **Output** | `Summary` · `Tests added or changed` · `Behaviours covered` · `Verification` · `Red tests and suspected product bugs` · `Source changes required (not made)` · `Not tested / out of scope` · `Insight candidates` |
| **Gate** | Asks 1–3 questions and stops when the behaviour to pin down, or the unit-vs-integration split, is undefined |

A failing test is a **finding**, not a task — it is reported, never resolved by
editing the code under test. The mocks convention (`TESTING.md`) is deliberate
and outranks generic "avoid mocks" advice.

### architecture-reviewer

| | |
|---|---|
| **Owns** | Layer and dependency-direction review of a branch diff or named path set. This repo has no linter, so the review *is* the enforcement |
| **Never** | Edits, runs the app or tests, reports an ungrounded or sub-threshold finding, flags a documented intentional deviation, issues a merge verdict, or strays into correctness/security review |
| **Tools** | `Read, Grep, Glob, Bash, Skill` — no `Edit`/`Write`, no `Agent`, no web |
| **Bash contract** | Read-only inspection only (`git diff`, `git log`, `git show`, `git blame`, `rg`, `ls`, `find`) |
| **Preloads** | `skills: onion-architecture, frontend-architecture` |
| **Input** | A review target — the branch diff by default, or explicit paths |
| **Output** | `Scope reviewed` · `Findings` · `Checked and clean` · `Not examined` · `Deliberately not flagged` · `Adjacent, out of lane` |
| **Gate** | Asks 1–3 questions and stops when the target, the diff baseline, or the review kind is ambiguous |

A finding needs the rule quoted, a `path:line` with the offending line, a
failure scenario, and confidence ≥ 8 — all four, or it is not reported. A
second, explicit filtering pass runs against the exclusion list before anything
is written. **Zero findings is a valid result**; `Checked and clean` is what
makes an empty `Findings` section trustworthy rather than merely unexamined.

### plan-verifier

| | |
|---|---|
| **Owns** | Checking delivered work against the plan that authorized it — one row per plan item, **and one per `AC-n`** in the plan's `Traceability` |
| **Never** | Reviews code quality, proposes refactors, edits anything, trusts an implementation report as evidence, marks an unevidenced item `done`, or issues an overall pass/fail |
| **Tools** | `Read, Grep, Glob, Bash` — **no `Skill`**, deliberately: without it the agent cannot load a review skill and drift into generic code review |
| **Bash contract** | Read-only inspection plus the touched packages' typecheck and test commands. No migrations, seeds, installs, Docker, or git state changes |
| **Input** | The **full** Implementation Plan text plus the branch or commit range holding the delivered work |
| **Output** | `Verdict summary` · `Plan item verdicts` · **`Acceptance criteria verdicts`** · `Commands run` · `Could not verify` · `Out-of-plan observations` |
| **Verdicts** | `done` · `partial` · `missing` · `deviated` · `unverified` |
| **Modes** | **Completeness pass** (Gate A, parallel with `architecture-reviewer`, before `test-writer`): `Tests` rows are `deferred to test-writer`, never `missing`; `typecheck` only, no suites. **Final pass**: everything, including the suites. Unstated dispatch means final |
| **Gate** | Asks 1–3 questions and stops when the plan text is a summary rather than the plan, or the delivered work is not identified |

It verifies work it did not do — a fresh model that never saw the reasoning
behind the change. Evidence is a `path:line` it read or a command it ran; an
item without that is `unverified`, never `done`, and a skipped integration suite
is `skipped (no Docker)`, never `passed`.

The `AC-n` rows are the point of the whole pipeline: a criterion whose plan step
shipped but whose behaviour could not be observed is `unverified`, because the
step existing is evidence about the builder, not about the criterion.

### doc-writer

| | |
|---|---|
| **Owns** | Documenting implemented features, routing each artifact to its destination, and drawing Mermaid diagrams in the house style |
| **Never** | Writes source, any `README.md`, `TESTING.md`, `CLAUDE.md`, `INSIGHTS.md`, `specs/**` or `<pkg>/specs/**`, or anything under `.claude/`; documents behaviour it could not verify; documents a feature that does not exist yet |
| **Tools** | `Read, Grep, Glob, Edit, Write, Bash, Skill` — no `Agent`, no web |
| **Blast radius** | Markdown under `docs/**` and `<pkg>/docs/**` only. Every other destination is proposed in the report, never written. Enforced by prompt, not by the tool layer |
| **Preloads** | `skills: mermaid-diagram` |
| **Input** | A plan, an implementation report, or a merged change — plus the intended audience when it is not obvious |
| **Output** | `Summary` · `Artifacts written` · `Routing decisions` · `Diagrams` · `Grounding` · `Unverified claims removed` · `Follow-ups for the user` |
| **Gate** | Asks 1–3 questions and stops when the artifact type, destination, or audience is undecided, or the feature is not yet implemented |

It routes by a decision table covering `docs/lessons/`, `docs/skills/`,
`docs/agent-prompts/`, standalone `docs/<subsystem>-architecture.md`, and
`<pkg>/docs/`. Note that `.claude/skills/**` (agent skills) and `docs/skills/*`
(the product's injectable prompt blocks, with YAML frontmatter) are different
things and must never be filed as each other.

## How the set composes

```
researcher              ──▶  facts (in-repo + external)
                              ▲
                              │  research requests, dispatched by the main session
                              │
spec-creator            ──▶  SPEC-NN under specs/  ──▶  [ user sets approved ]
                              │
implementation-planner  ──▶  Implementation Plan (+ ## Traceability)
                              │                  ──▶  [ user approves ]
                              ▼
        implementer   ◀── full plan text
                      code only in multi-agent mode; typecheck + narrow tests
                              │
              ┌───── Gate A ──┴───────────────┐   dispatched in parallel:
              ▼                               ▼   read-only, same branch diff
        architecture-reviewer          plan-verifier  (completeness pass)
              │                               │
              └───────────────┬───────────────┘
                              ▼
        implementer   ◀── Remediation Plan  (the findings, nothing beyond)
                              │
                              ▼
        test-writer   ──▶  tests + real suite results
                              │
                              ▼
        plan-verifier ◀── the same plan text, handed in again
                      final pass: Tests rows · AC-n rows · delta on findings
                              │
                              ▼
        /pr-self-review   (skips onion/frontend + mechanical checks
                           already covered upstream — see its SKILL.md)
                              │
                              ▼
        doc-writer    ──▶  docs/ artifact for what actually shipped
                              │
                              ▼
        /engineering-insights  ──▶  [ user sets SPEC-NN implemented ]
```

Each arrow crosses a context boundary. Nothing is shared implicitly — the report
returned by one agent is the only thing the next one receives.

**Everything below `[ user approves ]` is executed by
[`/run-plan`](../skills/run-plan/SKILL.md)** — it takes the approved plan and
drives implementer, Gate A, the capped remediation loop, tests, final
verification, the merge gate and docs. The two agents above that line,
`spec-creator` and `implementation-planner`, are run separately and by hand:
writing a spec and designing a plan are the two steps that most need a human in
the loop, and folding them into an orchestrator would hide exactly the decisions
worth stopping on.

Model choice follows the shape of the work, not the position in the pipeline.
`architecture-reviewer` and `test-writer` run on `sonnet`: the first works from
an explicit checklist behind a mechanical grounding gate, the second matches an
existing test corpus — both recognition tasks. `plan-verifier` stays on `opus`
because its value is the rows it honestly marks `unverified` or `missing`, and
that discipline is the first thing to degrade. The pipeline's real cost is
`implementer` in the remediation loop, not the reviewers.

Three things about this order are deliberate:

- **Gate A runs before `test-writer`, not after.** Both defects it catches are
  cheaper on the left. A layering violation found later moves code that tests
  have already bound themselves to; a missed plan item found later costs new
  code, new tests, another review and another verification. Both agents are
  read-only and take the same diff, so they are dispatched in one block rather
  than in sequence.
- **There is no `security-reviewer` agent.** Security is the `security-review`
  skill, run as step 5 of `/pr-self-review` — the pipeline's single security
  owner. Earlier versions of this diagram showed it as a separate lane; it never
  was one.
- **`Status: implemented` is a human act.** No agent can set it: `doc-writer`
  cannot write `specs/**`, and `spec-creator` writes `draft` only. The pipeline
  ends by *reminding*, not by flipping it — see `specs/README.md` for the
  `draft` → `approved` → `implemented` lifecycle.

### Test ownership follows the execution mode

The plan's `Execution mode` decides who writes tests, and both agents check it:

| Mode | `implementer` | `test-writer` |
|---|---|---|
| multi-agent | code only — writes **no** tests | owns every row of the plan's `## Tests` |
| single-agent | writes tests inline with the steps | not dispatched |

Leaving this implicit is how the same coverage gets authored twice, in two
contexts, with the suite run twice to prove it.

### Who runs the full suite

`implementer` runs `typecheck` plus tests **filtered to the files it changed**,
exactly once, after its last step. The full package suite is run by
`test-writer` and by `plan-verifier`'s final pass — the two agents whose runs
are the pipeline's actual evidence — and, when not already covered at the same
`HEAD`, by `/pr-self-review`. The trade is explicit: a behavioural regression in
an untouched package surfaces one hop later than it used to. `typecheck` still
runs everywhere, and in `server/` it also type-checks `reviewer-core`, which is
consumed as source through a tsconfig path alias.

## Rule sources

### External — Anthropic official (fetched 2026-08-08, re-verified 2026-08-09)

| Source | What it governs here |
|---|---|
| [Create custom subagents](https://code.claude.com/docs/en/sub-agents) | The full 16-field frontmatter set (only `name` + `description` required) and the two the house deliberately declines (`disallowedTools`, `permissionMode`); `tools:` as an allowlist (omission = removal, absent key = inherit everything); read-only via omitting `Edit`/`Write`; no `Agent` = no nesting; "design focused subagents"; "limit tool access"; "write detailed descriptions"; `description` driving auto-delegation, with "Use proactively"/"Use immediately after X" phrasing; `model` values incl. `inherit`; `color` value set; fresh-context isolation; `skills:` preloading full skill content |
| [Best practices for Claude Code](https://code.claude.com/docs/en/best-practices) | Writer/reviewer separation in a fresh context — "a reviewer … sees only the diff and the criteria you give it, not the reasoning that produced the change"; the warning that a reviewer prompted to find gaps will find them, and the instruction to "flag only gaps that affect correctness or the stated requirements" — hence implementer reports facts, not a verdict, and architecture-reviewer carries a confidence threshold; the **adversarial review step** that anchors plan-verifier — "Check that every requirement is implemented, the listed edge cases have tests, and nothing outside the task's scope changed. Report gaps, not style preferences."; "a fresh model try to refute the result, so the agent doing the work isn't the one grading it"; the trust-then-verify gap — "If you can't verify it, don't ship it" |
| [Anthropic's shipped security-review prompt](https://github.com/anthropics/claude-code-security-review/blob/main/.claude/commands/security-review.md) | The reviewer mechanism architecture-reviewer copies: explicit severity definitions, a confidence score 1–10 with a ≥8 reporting threshold, a two-phase pipeline whose second phase filters false positives against a documented exclusion list, a fixed finding skeleton, and findings derived by reading code rather than running it |
| [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) | The evaluator-optimizer workflow — generator and evaluator as separate LLM roles — the precedent for plan-verifier and architecture-reviewer existing separately from implementer |
| [Extend Claude with skills](https://code.claude.com/docs/en/skills) | How agents reach project skills via the `Skill` tool when not preloaded |
| [Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices) | Progressive disclosure — keep the agent body small, defer detail to the skills it loads; `description` as third-person *what + when* |
| [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) (2025-06-13) | Every delegated agent gets an objective, an output format, tool guidance, and clear task boundaries |

Not documented by Anthropic, and therefore local judgment — do not present any
of these as an official rule:

- The three-role implementation-planner → implementer → reviewer pipeline. The
  docs describe a two-role writer/reviewer split; evaluator-optimizer supports
  separating the roles but does not prescribe three.
- The ~110–140 line target for agent bodies. The 500-line guidance applies to
  `SKILL.md`, not agents; no official numeric limit exists.
- **`test-writer` may not edit non-test source to make a test pass.** The
  frequently-quoted 2024 Anthropic TDD guidance ("write tests from input/output
  pairs", "don't write implementation yet", "don't modify the tests") could not
  be re-verified on any currently-live Anthropic URL — the original post now
  redirects to a rewritten page without that section. The rule stands on the
  writer/reviewer-separation principle, not on a TDD quote.
- Assertion-free / tautological tests as a named anti-pattern — third-party only.
- Behaviour-not-implementation testing. Attributed, not quoted: Kent C. Dodds,
  [Testing Implementation Details](https://kentcdodds.com/blog/testing-implementation-details),
  and Martin Fowler, [Mocks Aren't Stubs](https://martinfowler.com/articles/mocksArentStubs.html).
- Diátaxis (tutorial / how-to / reference / explanation) as a doc-routing frame —
  an imported third-party framework ([diataxis.fr](https://diataxis.fr)). This
  repo's actual `docs/` layout is the binding routing authority, not Diátaxis.
- The Mermaid dialect in `doc-writer` — no Anthropic source; derived entirely
  from `docs/skills-architecture.md` and the root `README.md`.
- LLM-as-judge sycophancy / self-preference bias — academic literature, not
  Anthropic. The citable official mitigation is the "fresh model … isn't the one
  grading it" line above.

### In-repo authority

| Source | What it governs here |
|---|---|
| [`researcher.md`](researcher.md) | House prompt shape — folded-scalar `description`, `## Hard constraints` with bold labels, a `## Clarify first` gate, a fixed report skeleton with a mandatory negative-space section |
| [root `CLAUDE.md`](../../CLAUDE.md) | Package scoping and the session protocol (read the touched package's `INSIGHTS.md` first); no workspace (`pnpm -w`, sibling `pnpm add`); do-not-touch paths; never `docker compose down -v` |
| [`onion-architecture`](../skills/onion-architecture/SKILL.md) | Layer direction, ports before adapters, adapters only in `platform/container.ts`, Drizzle confined to `repository.ts`, never bypass `groundFindings()` |
| [`pr-self-review/guides/skill-matrix.md`](../skills/pr-self-review/guides/skill-matrix.md) | **The shared glob → skill table.** The implementation-planner derives the implementer's rulebook from it; the implementer falls back to it if the plan is silent. One source of truth for both |
| [`specs/TEMPLATE.md`](../../specs/TEMPLATE.md) | The canonical spec skeleton and the required shape of every section — EARS patterns, the `US`/`AC`/`EC` traceability matrix with its verification hint, the design-review table, the interaction map plus `Contract impact`, and the provenance / untrusted-input tables. `spec-creator` copies it rather than inventing a layout; [`specs/README.md`](../../specs/README.md) carries the repo-wide `SPEC-NN` numbering and the `draft` → `approved` → `implemented` lifecycle |
| [`engineering-insights`](../skills/engineering-insights/SKILL.md) | `INSIGHTS.md` is append-only with a duplicate check — so the implementer proposes candidate entries instead of writing them |
| `server/CLAUDE.md` · `client/CLAUDE.md` | `*.it.test.ts` naming for DB-backed tests; client-first `"use client"` as a considered decision, not drift |
| [`TESTING.md`](../../TESTING.md) | **The single source of truth for every test command.** `implementer`, `test-writer` and `plan-verifier` point at its §Running locally instead of each carrying its own copied table — four copies had already drifted apart. It also records why the split is invoked as `pnpm exec vitest run …` rather than through `test:unit` / `test:integration` scripts: `server/package.json` is `skip-worktree`, so CI deliberately does not rely on the committed file carrying them. `tsc --noEmit` is the only static gate — no lint exists in this repo |
| [`TESTING.md`](../../TESTING.md) §Philosophy | "Mock the outside world" via `server/src/adapters/mocks.ts` — **deliberately the opposite** of the generic "avoid mocks" advice in Anthropic's prompting examples, because the mocked surfaces are the non-deterministic, key-requiring, paid external boundaries, and the repo keeps one real-Postgres integration lane for everything else. The repo wins; `test-writer` says so explicitly |
| [`severity-rubric.md`](../skills/pr-self-review/guides/severity-rubric.md) | The Critical/High/Medium/Low scale and the "don't flag as issues at all" list — the exclusion list `architecture-reviewer` filters against, alongside the documented onion deviations in [`pitfalls-and-tradeoffs.md`](../skills/onion-architecture/guides/pitfalls-and-tradeoffs.md) |
| `.claude/settings.local.json` | Verification commands are chosen to sit inside the existing `permissions.allow` list so agents don't stall on prompts. `reviewer-core/` and `mcp/` use `npm run typecheck`, which needs its own entry — `Bash(npm test *)` does not cover it |

## Conventions for new agents

- Frontmatter: `name` and `description` are the only **required** fields.
  `description` is a folded scalar, third person, stating *what* and *when* — it
  drives automatic delegation, so phrasing like "Use proactively" or "Use
  immediately after X" is deliberate, not filler. The house also always sets
  `model` and `tools`, and usually `color`; `skills` when preloading is worth the
  startup context. `color` is cosmetic and accepts `red, blue, green, yellow,
  purple, orange, pink, cyan`. `model` accepts `sonnet | opus | haiku | fable`, a
  full model ID, or `inherit` (the default when omitted).
- The full supported set is larger than the house uses: `name`, `description`,
  `tools`, `disallowedTools`, `model`, `permissionMode`, `maxTurns`, `skills`,
  `mcpServers`, `hooks`, `memory`, `background`, `effort`, `isolation`, `color`,
  `initialPrompt`. **The house deliberately declines `disallowedTools` and
  `permissionMode`.** `tools` is already an allowlist where omission is removal,
  so `disallowedTools` is redundant for a read-only agent — and it is
  *tool-name*-scoped, so it cannot express a *path* restriction like
  `test-writer`'s "tests only" or `doc-writer`'s "markdown under `docs/` only";
  those stay prompt-enforced. `permissionMode` changes the posture inherited from
  `.claude/settings.local.json` and is a user configuration decision, not an
  agent author's.
- Do **not** use `permissions:` or `allowed-tools:` — those are Skills fields and
  appear nowhere in the agent field set. Omitting `tools` entirely makes the
  agent inherit every subagent-available tool, which is why every house agent
  sets it explicitly.
- Grant the narrowest `tools` list that works. Omission is the enforcement
  mechanism; there is no per-command `Bash` restriction at the tool level, so any
  command allow/deny list in an agent body is prompt-enforced only.
- Give the agent a single job, an explicit output skeleton, and a section for what
  it deliberately did *not* do.
- Add the agent to the catalog table above in the same change.
