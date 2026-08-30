# Findings catalog

Fourteen checks. Each row is a finding id, its detection, its default tier, and the remediation the
report should **propose** (never perform). Escalate or de-escalate a tier when the evidence warrants
it, and say why when you do.

## External dependency findings

### DEP-01 — Version drift across packages

The same package declared at different ranges in two or more manifests. Detect by joining every
manifest's `dependencies` + `devDependencies` on package name and comparing ranges.

Default **P1**. Escalate to **P0** for a schema/validation or runtime-identity library (`zod`, a
DI container, an ORM) whose two copies can be reachable from one process — see DEP-12.

Propose: pick the highest range in use, name each file to edit, and note that with no workspace
nothing enforces this going forward.

### DEP-02 — Unused declared dependency

Declared in `package.json`, imported nowhere in that package. Detect by grepping the package's own
sources for the specifier.

Rule out first: config-only consumers, `@types/*`, binaries invoked from `scripts`, and plugins loaded
by name through another tool's config. Only report after all four are excluded.

Default **P1**. Propose removal from the named `package.json` for the user to confirm.

### DEP-03 — Phantom (imported but undeclared) dependency

Imported by source, absent from that package's `package.json`. Resolves today only via hoisting or a
sibling install; breaks on a clean isolated install, which is what CI does.

Default **P0** when it currently resolves only by accident, **P1** otherwise. Propose adding it
explicitly to the correct dependency block.

### DEP-04 — Runtime import of a devDependency

A package under `devDependencies` imported from code that ships or runs in production.

Default **P1**, **P0** if the production start path would throw. Propose moving it to `dependencies`.

### DEP-12 — Duplicate instances of one library

Two installed copies of the same library reachable from a single runtime — via drift (DEP-01), a
resolution pin, or two lockfiles resolving the same range differently.

Default **P0** for validation, schema, or class-identity libraries: `instanceof` fails, branded types
stop matching, and the symptom appears far from the cause. **P2** for stateless utilities.

Propose a single resolved version, and state which mechanism will hold it there.

### DEP-14 — Known vulnerability or stale major *(online pass only)*

From `npm audit` / `pnpm audit` and `npm outdated`. Only produced when the user asked for the online
pass; label every such finding as network-derived.

Default: tier by advisory severity — critical/high → **P0**, moderate → **P1**, low → **P2**. A stale
major with no advisory is **P2**.

## Internal-structure findings

### DEP-05 — Deep relative import into another package's internals

An import that reaches into a sibling package by relative path or past its public entry point —
`../reviewer-core/src/pipeline.js` rather than the package's index.

Default **P0**. It bypasses the entry point, pins the consumer to the producer's internal file
layout, and hides the edge from every manifest.

Propose routing through the package's public entry point (here, the `@devdigest/reviewer-core` alias
declared in `server/tsconfig.json`).

### DEP-06 — Cycle between packages

Two packages whose tsconfig `paths` point at each other's source. Detect from the alias table, not
from imports alone.

Default **P1**, **P0** if it forces a build-order workaround or a hand-installed dependency in CI.

Propose extracting the shared surface into a package both can depend on one-way.

### DEP-07 — Vendored-copy drift

Two directories intended to be copies of the same module that no longer match. Detect with
`diff -rq`.

Default **P1**. Name the differing files. Propose one source of truth plus a sync check, and note
that a silent contract divergence between client and server is a wire-format bug waiting to happen.

## Infrastructure findings

### DEP-08 — Mixed package managers / lockfile format split

More than one lockfile format across the repo's packages. Two resolution algorithms, two caches, two
CI install paths, and no shared resolution.

Default **P1**. Propose standardizing on one manager, and note the migration cost honestly.

### DEP-09 — Orphaned `node_modules`

A `node_modules/` directory with no sibling `package.json`. Nothing can reinstall, audit, or update
it.

Default **P2**. Report its size. Propose deletion for the user to confirm — never delete it yourself.

### DEP-13 — Missing `engines` / `packageManager` pin

No `engines.node` and no `packageManager` field, so nothing stops a contributor installing with the
wrong manager or an incompatible Node.

Default **P2**. Propose adding both to every manifest, matching the version CI already uses.

## Size findings

### DEP-10 — Heavy browser dependency

A large package in `client/dependencies` that reaches the browser bundle. Report installed size, and
say plainly that installed size is a proxy for shipped size, not a measurement of it — only a bundle
analyzer measures the latter.

Default **P2**, **P1** when a materially lighter alternative covers the actual usage or when the
import is not code-split.

Propose dynamic import, a narrower entry point, or a lighter alternative — whichever fits the usage
you observed.

### DEP-11 — Heavy native or binary dependency

Native addons and postinstall binary downloads inflate install time, image size, and CI cache, and
they constrain the platforms a build can target.

Default **P2**. Report size and note the platform coupling. Propose nothing unless the dependency is
also unused (then DEP-02 applies).
