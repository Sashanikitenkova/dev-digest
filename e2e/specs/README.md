# specs/ — e2e

This folder holds **two different kinds of file**, deliberately side by side:

| Pattern | What it is | Written by |
|---|---|---|
| `NN-<name>.flow.json` | A deterministic browser flow the runner executes (`./scripts/e2e.sh`) | hand-authored |
| `SPEC-NN-YYYY-MM-DD-<slug>.md` | A specification for e2e coverage itself | [`spec-creator`](../../.claude/agents/spec-creator.md) |

The flows are the executable artifact and are unaffected by anything here — a
spec never renames, renumbers, or rewrites a `.flow.json`. Their numbering
sequences are independent: `04-pr-findings.flow.json` has nothing to do with
`SPEC-04`.

Markdown specs copy [`specs/TEMPLATE.md`](../../specs/TEMPLATE.md).
`SPEC-NN` is unique **repo-wide**, not per folder, and the status lifecycle
(`draft` → `approved` → `implemented`, the last two immutable) is documented in
the [root README](../../specs/README.md). A feature that also touches another
package belongs in the repo-root [`specs/`](../../specs/README.md) instead.

## Index

_Nothing added yet._

| Spec | Title | Created | Status | Scope |
|---|---|---|---|---|
