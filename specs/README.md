# specs/ — cross-package

Specifications for DevDigest's spec-driven development. Written by the
[`spec-creator`](../.claude/agents/spec-creator.md) agent and consumed by
[`implementation-planner`](../.claude/agents/implementation-planner.md).

**This folder holds only specs that touch two or more packages.** A spec scoped
to a single package lives in that package's own folder:
[`server/specs/`](../server/specs/) · [`client/specs/`](../client/specs/) ·
[`reviewer-core/specs/`](../reviewer-core/specs/) · [`e2e/specs/`](../e2e/specs/).
`mcp/specs/` is created on first use.

The canonical skeleton is [`TEMPLATE.md`](TEMPLATE.md) — every spec, in every
folder, copies it.

## Naming and numbering

- Filename: `SPEC-NN-YYYY-MM-DD-<feature-slug>.md`.
- **`SPEC-NN` is unique repo-wide**, not per folder. Before writing, glob
  `{specs,*/specs}/SPEC-*.md`, take the highest `NN`, add one.
- Cross-references use the bare ID (`SPEC-07`), never the filename — so a spec
  can be renamed without breaking links.
- `Created:` is the date the spec was first written and never changes.

## Status lifecycle

| Status | Meaning | Who sets it |
|---|---|---|
| `draft` | Being written or under discussion; freely editable | `spec-creator` |
| `approved` | Agreed; the planner may build against it | a human |
| `implemented` | Shipped | a human |

`approved` and `implemented` specs are **immutable**. Changing a decision means
a new spec whose `Supersedes:` names the old ID — the superseded file stays
where it is, as the record of what was decided and when.

## Index

| Spec | Title | Created | Status | Scope |
|---|---|---|---|---|
| [SPEC-01](SPEC-01-2026-08-26-project-context-folder.md) | Project Context Folder | 2026-08-26 | draft | `server` · `client` · `reviewer-core` |
| [SPEC-02](SPEC-02-2026-08-29-pr-why-risk-brief.md) | Why + Risk Brief for Pull Requests | 2026-08-29 | approved | `server` · `client` |
| [SPEC-03](SPEC-03-2026-08-30-eval-pipeline.md) | Eval Pipeline for Reviewer Agents | 2026-08-30 | draft | `server` · `client` |
