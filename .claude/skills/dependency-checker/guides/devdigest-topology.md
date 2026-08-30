# DevDigest topology

The map, so a run does not have to re-derive it. Verify anything you intend to cite — this file
records the shape as of the `l06-evals` branch.

## The five packages

| Path | Name | Kind | Manager | Lockfile |
|---|---|---|---|---|
| `client/` | `@devdigest/web` | Browser frontend (Next.js 15, React 19) | pnpm | `pnpm-lock.yaml` v9 |
| `server/` | `@devdigest/api` | Node backend (Fastify 5, Drizzle, Postgres) | pnpm | `pnpm-lock.yaml` v9 |
| `reviewer-core/` | `@devdigest/reviewer-core` | Pure library, consumed as **source** | npm | `package-lock.json` v3 |
| `e2e/` | `@devdigest/e2e` | Test harness (CDP-driven) | npm | `package-lock.json` v3 |
| `evals/` | `@devdigest/evals` | Eval harness (Claude Agent SDK, vitest) | pnpm | `pnpm-lock.yaml` v9 |

There is **no root `package.json`**, no `pnpm-workspace.yaml` at the root, no turbo/nx/lerna config,
and no `workspaces` field. `client/` and `server/` both set `node-linker=hoisted` in `.npmrc`.

## Internal edges (tsconfig `paths`)

| From | Alias | Resolves to | Kind |
|---|---|---|---|
| `server` | `@devdigest/reviewer-core` | `../reviewer-core/src/index.ts` | Cross-package source edge |
| `server` | `@devdigest/shared` | `./src/vendor/shared/index.ts` | Vendored, in-package |
| `reviewer-core` | `@devdigest/shared` | `../server/src/vendor/shared/*` | Cross-package source edge |
| `reviewer-core` | `zod` | `./node_modules/zod` | **Resolution pin, not an edge** |
| `client` | `@devdigest/shared` | `./src/vendor/shared/*` | Vendored copy of the same contracts |
| `client` | `@devdigest/ui` | `./src/vendor/ui/*` | Vendored, in-package |

`server` and `reviewer-core` therefore point at each other's source — a genuine package-level cycle.

`e2e/` and `evals/` declare no `paths` at all.

## Consequences worth reporting

- **`reviewer-core/node_modules` is required at server runtime**, because the server imports
  `reviewer-core`'s TypeScript source rather than a built artifact. CI compensates by running
  `npm ci` inside `reviewer-core` before the server's typecheck and tests
  (`.github/workflows/server-unit.yml`, `.github/workflows/e2e-web.yml`). An invisible edge that CI
  has to hand-patch is a legitimate P0/P1 finding.
- **The `zod` pin in `reviewer-core/tsconfig.json`** exists to stop `zod` resolving to the server's
  copy. Treat it as *evidence* of a duplicate-instance hazard, not as a defect in itself. Two `zod`
  instances reachable from one runtime make `instanceof` checks and branded types fail silently.
- **`client/src/vendor/shared` and `server/src/vendor/shared` are two copies of the same notional
  package** and have diverged. Diff them before reporting; name the differing files.
- **`server/clones/`** is gitignored and holds a complete second checkout of this repository. Exclude
  it from every scan.

## Known-intentional — do not flag

Move these to the report's `## Checked and clean` section instead of raising them:

- `dependency-cruiser`, `graphology`, `graphology-metrics`, `@ast-grep/napi`, and `@vscode/ripgrep`
  in `server/dependencies` are **runtime libraries of the `repo-intel` product feature**
  (`server/src/modules/repo-intel/`, wired in `server/src/platform/container.ts`). They analyze the
  *user's* repositories. They are not dev tooling, they are not misplaced in `dependencies`, and their
  presence does **not** mean the repo already has dependency-hygiene tooling.
- `evals/pnpm-workspace.yaml` is **not** a workspace declaration. It carries only pnpm 10's
  `allowBuilds` allowlist for esbuild — the same intent as `pnpm.onlyBuiltDependencies` in
  `evals/package.json`.
- `reviewer-core` having a large `node_modules` for two declared dependencies is expected: `openai` is
  bulky.
- `client/` being the only package where browser bundle size matters is by design. `server/` ships
  unbundled via `tsc`, so *install* size is its metric, not bundle size.

## Where size actually matters

| Package | Metric | Why |
|---|---|---|
| `client/` | Browser bundle | The only package that ships JavaScript to a browser |
| `server/` | Install / image size | Unbundled `tsc` output; every runtime dep lands in the deployed artifact, including native addons |
| `reviewer-core/` | Install size | Pulled in at server runtime as source |
| `e2e/`, `evals/` | Neither, materially | Dev-only harnesses; report their size as Info |
