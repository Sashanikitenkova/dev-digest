# References

Sources this skill draws on, kept in full rather than trimmed.

## This repository

- `README.md` — the "no monorepo workspace … shared through tsconfig path aliases" statement that
  every rule in this skill follows from.
- `server/tsconfig.json`, `client/tsconfig.json`, `reviewer-core/tsconfig.json` — the authoritative
  internal edge list, including `reviewer-core`'s `zod` resolution pin.
- `.github/workflows/server-unit.yml`, `.github/workflows/e2e-web.yml` — the hand-added `npm ci` in
  `reviewer-core` that compensates for the invisible source edge, with comments naming the failure
  (TS2307 / ERR_MODULE_NOT_FOUND).
- `evals/skills/dependency-checker/dependency-checker.cases.ts` — the graded acceptance criteria for
  the report contract.
- `evals/src/skill-quality.ts` — the static gate: `name` must equal the directory name; every relative
  link in `SKILL.md` must resolve.
- `.claude/skills/onion-architecture-workspace/skill-v1-snapshot/SKILL.md` — the house skill format
  this one follows, and the origin of the "Checked and clean" section.

## Package manager behaviour

- pnpm store and symlink layout — why `node_modules/<pkg>` is a symlink and real content lives under
  `node_modules/.pnpm/<pkg>@<version>/node_modules/<pkg>`. This is the source of the sizing trap.
- pnpm `node-linker=hoisted` — what `client/.npmrc` and `server/.npmrc` change about that layout.
- npm `lockfileVersion: 3` flat tree — why the plain `du` form is correct in `reviewer-core/` and
  `e2e/`.
- pnpm 10 `onlyBuiltDependencies` / `allowBuilds` — why `evals/pnpm-workspace.yaml` exists without
  declaring a workspace.

## Dependency analysis concepts

- Phantom dependencies and the hoisting hazard — imports that resolve only because something else
  installed the package.
- Duplicate module instances — why two copies of a validation library break `instanceof` and branded
  types, and why the symptom surfaces far from the cause.
- Public entry point vs deep import — the coupling cost of reaching past a package's index.
- Installed size vs shipped bundle size — why the first is only a proxy for the second, and what a
  bundle analyzer measures that `du` cannot.

## Tools this repo does not use, worth proposing as findings

- `knip` / `depcheck` — unused and phantom dependency detection.
- `syncpack` — version drift across manifests; directly targets DEP-01.
- `madge` / `dependency-cruiser` (as *tooling*, distinct from the server's product use of it) —
  import-graph and cycle detection.
- `@next/bundle-analyzer` — the only way to turn DEP-10 from a proxy into a measurement.
- Renovate / Dependabot — neither is configured here.
