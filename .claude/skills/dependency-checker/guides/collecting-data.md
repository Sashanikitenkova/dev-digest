# Collecting the data

Everything here works by hand. [`../scripts/collect-deps.mjs`](../scripts/collect-deps.mjs) automates
the mechanical parts, but the report must be producible without it — including when the data is
handed to you in the prompt.

## 1. Manifests

```bash
find . -name package.json -not -path "*/node_modules/*" -not -path "*/.next/*" -not -path "*/clones/*"
```

Three exclusions, all load-bearing:

- `node_modules/` — obvious.
- `client/.next/` — build output; `client/.next/package.json` is generated, not a source manifest.
- `server/clones/` — gitignored, and it holds a **full checked-out copy of this same repository**
  used by the review pipeline. Scanning it doubles every package, every dependency, and every size.

For each manifest record: path, `name`, `private`, `dependencies`, `devDependencies`, and any
`engines` / `packageManager` field (this repo has neither anywhere).

## 2. Internal cross-package edges

There is no `workspace:*` and no `file:` dependency in this repo. Internal edges live in two places:

**tsconfig `paths`** — read `compilerOptions.paths` from each package's `tsconfig.json`. An entry
resolving to `../<other>/src/...` is a real cross-package source edge. An entry resolving to
`./src/...` is internal to that package (an alias, not an edge).

**Vendored copies** — a directory such as `src/vendor/shared` that duplicates another package's
source. These are edges in intent but copies in fact, so they can *drift*. Diff them:

```bash
diff -rq client/src/vendor/shared server/src/vendor/shared
```

## 3. Import graph

**Always pass `rg --text`.** Three tracked TypeScript files in `server/` embed a literal NUL byte as
a composite-key separator (`server/src/adapters/depgraph/index.ts`,
`server/src/modules/repo-intel/pipeline/repo-map.ts`, `server/src/platform/model-router.ts`).
ripgrep classifies those files as binary and **silently** suppresses every match in them — with no
warning in a `-l` or `-c` listing. Any dependency imported only from one of those files reads as
unused. This is not hypothetical: it is exactly how `dependency-cruiser` gets misreported, when it is
in fact imported at `server/src/adapters/depgraph/index.ts:17`.

Use ripgrep against the package's own sources only:

```bash
rg -n --no-heading -g '!node_modules' "from ['\"]<specifier>" server/src
```

To enumerate what a package actually imports, capture every specifier and split it:

```bash
rg -oNI "from ['\"]([^'\"]+)['\"]" -r '$1' client/src | sort -u
```

Bare specifiers (no leading `.` or `/`) are npm packages or aliases; scoped names keep their first
two segments (`@scope/name`). Relative specifiers that climb out of the package (`../../reviewer-core/...`)
are the DEP-05 signal.

## 4. Sizes — and the pnpm trap

**This is the most likely place to get a wrong number.**

`client/`, `server/`, and `evals/` are pnpm installs. Their top-level `node_modules/<pkg>` entries are
**symlinks into `node_modules/.pnpm/`**, so `du` follows nothing and reports ~0 for every package:

```bash
# WRONG in a pnpm package — prints 0.0 MB for everything
du -sk client/node_modules/* | sort -rn | head

# RIGHT
du -sk client/node_modules/.pnpm/*/node_modules/* 2>/dev/null | sort -rn | head -20
```

`reviewer-core/` and `e2e/` are npm installs with a flat, real tree, so the plain form is correct
there. Detect which you are in by the lockfile: `pnpm-lock.yaml` → `.pnpm` layout;
`package-lock.json` → flat layout.

Whole-package totals are honest either way:

```bash
du -sh <pkg>/node_modules
```

Two reporting rules:

- A `.pnpm` directory name is `<pkg>@<version>[_<peer hashes>]`. Strip the version and peer suffix
  for display, but keep the version when the finding is about drift or duplicates.
- The number you get is the package's **own** size, not its subtree. Say so. Never add own-sizes
  together and present the total as the install size.

## 5. Unused and phantom dependencies

**Unused** — declared in `package.json`, imported nowhere. Rule out **all seven** false-positive
classes before reporting. The first three each produced a wrong answer while this skill was being
written; do not skip them.

1. **Binary-classified files** — you searched without `--text`. See §3.
2. **Side-effect imports** — `import 'dotenv/config';` has no `from` clause
   (`server/src/platform/config.ts:1`).
3. **Dynamic imports** — `await import('@vscode/ripgrep' as string)`, often with a cast or a
   vite-ignore comment (`server/src/adapters/codeindex/ripgrep.ts:33`).
4. Config-only consumers — `postcss.config.*`, `tailwind.config.*`, `vitest.config.*`,
   `next.config.*`, `drizzle.config.*`. Search the package root, not only `src/`.
5. Type-only packages — `@types/*` are used by the compiler, never by an import.
6. Binary-only packages — invoked from a `scripts` entry (`tsx`, `drizzle-kit`), never imported.
7. Framework-implicit packages — `react-dom` has zero direct imports in `client/src` yet Next.js
   requires it at runtime. Plugins loaded by name through another tool's config
   (`@tailwindcss/postcss`) are the same class.

A verified true positive, after all seven pass: `@fastify/autoload` in `server/package.json`. Its
only occurrence anywhere is a comment at `server/src/modules/index.ts:17` explaining that modules are
registered explicitly *instead of* filesystem autoload.

**Phantom** — imported by source, absent from that package's `package.json`. These resolve today only
by accident: hoisting, or a sibling package's install on the same machine. They break on a clean
install in isolation, which is exactly what CI does.

## 6. Orphans and lockfiles

```bash
find . -maxdepth 3 -name node_modules -type d -not -path "*/node_modules/*"
```

Any hit whose sibling `package.json` does not exist is an orphan — nothing can reinstall, audit, or
update it.

For lockfiles, record path, format (`pnpm-lock.yaml` vs `package-lock.json`), and version
(`lockfileVersion`). Two formats in one repo means two resolution algorithms, two caches, and two CI
install paths.

## 7. Online pass — opt in only

Default is fully offline: lockfiles and `node_modules` on disk. Run these only when the user asks,
and label the resulting findings as network-derived:

```bash
npm audit --json          # in each package dir
npm outdated --json
```

Both need the package's own manager; in a pnpm package use `pnpm audit` / `pnpm outdated`.
