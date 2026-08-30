---
name: dependency-checker
description: Analyzes and reports on DevDigest's dependencies — external npm packages per package.json/lockfile, internal cross-package edges (tsconfig path aliases and vendored src/vendor/shared copies, never workspace:*), installed size, version drift, unused and phantom deps. Produces a fixed-structure report — Scope, Mermaid graph, size tables, P0/P1/P2/Info findings, prioritized summary. Use when auditing dependencies, adding or removing a package, investigating install or bundle size, or reviewing a PR that touches package.json, a lockfile, or tsconfig paths. Does not cover Drizzle query syntax (see drizzle-orm-patterns) or Next.js bundling configuration (see next-best-practices).
---

# Dependency Checker

DevDigest is **not a monorepo**. Five standalone packages each own a `package.json` and a lockfile;
they are linked only through tsconfig `paths` aliases and vendored source copies. No `workspace:*`
protocol and no `file:` link exists anywhere in this repo — claiming otherwise is the single most
common way to get this analysis wrong. Every rule below cites a real path here.

The deliverable is always **one report in the fixed structure below**. Produce it in your response.
Write it to `.claude/runs/dependency-check-<YYYY-MM-DD>/report.md` only when the user asks you to
persist it.

## When to Use

- Auditing the repo's dependencies, their sizes, or their relationships.
- Adding, removing, or upgrading an npm package in any of the five packages.
- Investigating install size (`server/`) or browser bundle size (`client/`).
- Reviewing a change that touches a `package.json`, a lockfile, or `tsconfig.json` `paths`.

## The Report Contract

All six sections, in this order, with these headings. Sections 1–5 are mandatory; section 6 is
mandatory whenever the analysis touched code this repo has deliberately compromised on.

| # | Heading | What goes in it |
|---|---|---|
| 1 | `## Scope` | Which packages were analyzed, and what was excluded and why |
| 2 | `## Dependency graph` | A fenced ` ```mermaid ` block using `flowchart` |
| 3 | `## Size breakdown` | A table of dependency → installed size; never a prose estimate |
| 4 | `## Findings & Priorities` | Findings grouped under `### P0`, `### P1`, `### P2`, `### Info` |
| 5 | `## Summary` | 3–5 concrete takeaways, ordered by priority |
| 6 | `## Checked and clean — do not "fix" these` | Intentional compromises explicitly cleared |

Non-negotiable rules for the content:

- **Every finding names a specific package, dependency, or file.** "Consider optimizing dependencies"
  is not a finding. `moment is declared in server/package.json but imported nowhere under server/src`
  is.
- **Separate internal from external dependencies.** A tsconfig alias into a sibling package's source
  and a vendored copy of a contract module are a different kind of edge from an npm install. Say
  which is which; never merge them into one list.
- **Propose, never execute.** Removals, upgrades, and installs are recommendations for the user to
  confirm. Do not edit a manifest or run an install as part of producing the report.
- If you are working from data handed to you rather than gathered yourself, produce the report from
  that data directly. Do not ask for tool access before answering.

See [`guides/report-template.md`](guides/report-template.md) for the copyable skeleton and graph
conventions.

## Severity Rubric

| Tier | Meaning | Typical members |
|---|---|---|
| **P0** | Breaks correctness, security, or a build/deploy — now or on the next clean install | Duplicate module instances of a schema/validation library; a deep relative import into another package's internals; a package CI must hand-install for the build to compile; a known-exploited vulnerability |
| **P1** | Real, accruing cost; nothing is broken yet | Version drift on shared tooling; unused runtime dependency; phantom (imported but undeclared) dependency; mixed package managers; vendored-copy drift |
| **P2** | Size and hygiene | Heavy browser dependency with a lighter alternative; orphaned `node_modules`; missing `engines` / `packageManager` pin |
| **Info** | Observed, no action proposed | Sizes that are simply large and unavoidable; deliberate design choices worth stating |

Rank within a tier by **impact × confidence**, using fix effort only as the tiebreak. State the
confidence when a finding rests on inference rather than a file you read.

## Quick Reference

| If you see... | Do this | Why |
|---|---|---|
| The same package at different versions in two `package.json` files | Report as DEP-01 version drift, P1, naming both files and both ranges | No workspace means nothing reconciles them; they drift silently |
| A package declared in `package.json` with no import under that package's `src/` | Check config files first (postcss, tailwind, vitest setup, `@types/*`), then report DEP-02, P1 | Config-only and type-only consumers are the standard false positive |
| An import reaching into `../<other-package>/src/...` by relative path | Report DEP-05, **P0** — recommend routing through that package's public entry point | It bypasses the entry point and pins the consumer to the producer's internal file layout |
| `du -sh node_modules/<pkg>` returning ~0 in `client/`, `server/`, or `evals/` | Re-measure under `node_modules/.pnpm/` | Those are pnpm installs; top-level entries are symlinks |
| `dependency-cruiser`, `graphology`, `@ast-grep/napi`, or `@vscode/ripgrep` in `server/` | Clear it in section 6 | They are runtime libraries of the `repo-intel` product feature, not dev tooling |
| A `node_modules/` with no sibling `package.json` | Report DEP-09, P2 — recommend deletion for the user to confirm | Nothing can reinstall or audit it; it is dead weight |

## Guides

- [`guides/collecting-data.md`](guides/collecting-data.md) — how to gather each signal: manifests,
  internal edges, sizes (and the pnpm symlink trap), unused vs phantom, orphans, and opt-in online
  checks.
- [`guides/devdigest-topology.md`](guides/devdigest-topology.md) — this repo's actual map, and the
  known-intentional compromises that must not be reported as bugs.
- [`guides/findings-catalog.md`](guides/findings-catalog.md) — DEP-01…DEP-14: what each check is, how
  to detect it, its default tier, and the remediation to propose.
- [`guides/report-template.md`](guides/report-template.md) — the report skeleton, graph conventions,
  and a filled example.
- [`references.md`](references.md) — sources this skill draws on.

## Rules Checklist

- Never describe the packages as a monorepo, a pnpm workspace, or linked by `workspace:*` / `file:`.
  They are linked by tsconfig `paths` and by vendored source copies.
- Produce all six sections in order, even when a section is short. An empty `### P0` reads
  `_None._` — do not silently drop the heading.
- Measure sizes; do not estimate them. If you could not measure, say so and label the number as
  unverified rather than inventing one.
- Report own-package installed size, and say that it excludes transitive dependencies. Do not present
  an own-size number as a total.
- Exclude `node_modules/`, `client/.next/`, and the gitignored `server/clones/` tree from every scan.
  `server/clones/` contains a full second checkout of this same repo and will double every count.
- Check config files and type-only usage before calling a dependency unused.
- A dependency imported by source but missing from `package.json` is P0 if it only resolves today by
  accident (hoisting, a sibling package's install), P1 otherwise.
- Treat two installed copies of a validation/schema library reachable from one runtime as P0 — the
  failure mode is `instanceof` and branded types silently not matching.
- In the Mermaid graph, distinguish alias edges from vendored copies visually and label the edge with
  the alias or path. One subgraph per package.
- Never present a removal, upgrade, or install as done. Phrase it as a proposal and name the exact
  file to change.
- When a finding restates something the repo already documents as a deliberate tradeoff, move it to
  section 6 instead of raising it.
- Stay offline by default. Run `npm audit` / `npm outdated` only when the user asks for the online
  pass, and mark those findings as network-derived.
