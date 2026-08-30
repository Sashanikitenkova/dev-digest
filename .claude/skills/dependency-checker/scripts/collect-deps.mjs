#!/usr/bin/env node
/**
 * dependency-checker — data collector.
 *
 * Read-only. Never installs, edits, or deletes. Prints one JSON object to stdout:
 *   { repoRoot, generatedAt, packages[], lockfiles[], internalEdges[], drift[], sizes{}, orphans[] }
 *
 * This is an accelerator, not a dependency of the skill: the report must be producible from data
 * gathered by hand or handed over in a prompt.
 *
 *   node .claude/skills/dependency-checker/scripts/collect-deps.mjs [repoRoot] [--top N]
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

const args = process.argv.slice(2);
const topIdx = args.indexOf("--top");
const TOP = topIdx === -1 ? 15 : Number(args[topIdx + 1]) || 15;
const ROOT = resolve(args.find((a) => !a.startsWith("--") && a !== String(TOP)) ?? process.cwd());

/** Directories that must never be scanned — see guides/collecting-data.md. */
const SKIP = new Set(["node_modules", ".next", ".git", "clones", "dist", ".turbo"]);

const rel = (p) => relative(ROOT, p) || ".";

/**
 * Strip JSONC comments with a scanner that tracks string state. A regex cannot do this: tsconfig
 * path aliases such as "@devdigest/shared/*" contain a literal /* that naive stripping reads as the
 * start of a block comment, silently truncating the file.
 */
function stripJsonc(raw) {
  let out = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    const next = raw[i + 1];
    if (inLineComment) {
      if (c === "\n") {
        inLineComment = false;
        out += c;
      }
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** Plain JSON first (lockfiles, package.json); JSONC stripping only as a fallback (tsconfig). */
function readJsonc(file) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    /* fall through to the JSONC path */
  }
  try {
    return JSON.parse(stripJsonc(raw));
  } catch {
    return null;
  }
}

function walk(dir, depth, out) {
  if (depth < 0) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (SKIP.has(e.name)) continue;
    const full = join(dir, e.name);
    if (existsSync(join(full, "package.json"))) out.push(full);
    walk(full, depth - 1, out);
  }
  return out;
}

/** `du -sk` in batches, so a long argument list never overflows. */
function duKb(paths) {
  const sizes = new Map();
  for (let i = 0; i < paths.length; i += 150) {
    const batch = paths.slice(i, i + 150);
    let out = "";
    try {
      out = execFileSync("du", ["-sk", ...batch], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch (err) {
      out = err.stdout ?? "";
    }
    for (const line of out.split("\n")) {
      const m = line.match(/^(\d+)\s+(.+)$/);
      if (m) sizes.set(m[2], Number(m[1]));
    }
  }
  return sizes;
}

const mb = (kb) => Math.round((kb / 1024) * 10) / 10;

/** `@next+swc-darwin-arm64@15.5.19_peer_hash` -> { name: "@next/swc-darwin-arm64", version: "15.5.19" } */
function decodePnpmDir(entry) {
  const at = entry.lastIndexOf("@");
  if (at <= 0) return null;
  const name = entry.slice(0, at).replace("+", "/");
  const version = entry.slice(at + 1).split("_")[0];
  return { name, version };
}

// ---------------------------------------------------------------- manifests

const packages = [];
const rootPkg = join(ROOT, "package.json");
const pkgDirs = existsSync(rootPkg) ? [ROOT, ...walk(ROOT, 3, [])] : walk(ROOT, 3, []);

for (const dir of pkgDirs) {
  const pkg = readJsonc(join(dir, "package.json"));
  if (!pkg) continue;
  const manager = existsSync(join(dir, "pnpm-lock.yaml"))
    ? "pnpm"
    : existsSync(join(dir, "package-lock.json"))
      ? "npm"
      : existsSync(join(dir, "yarn.lock"))
        ? "yarn"
        : "none";
  packages.push({
    dir: rel(dir),
    name: pkg.name ?? basename(dir),
    version: pkg.version ?? null,
    private: pkg.private === true,
    manager,
    engines: pkg.engines ?? null,
    packageManager: pkg.packageManager ?? null,
    dependencies: pkg.dependencies ?? {},
    devDependencies: pkg.devDependencies ?? {},
    scripts: Object.keys(pkg.scripts ?? {}),
    hasNodeModules: existsSync(join(dir, "node_modules")),
  });
}

// ---------------------------------------------------------------- lockfiles

const lockfiles = [];
for (const p of packages) {
  const dir = join(ROOT, p.dir === "." ? "" : p.dir);
  for (const [file, format] of [["pnpm-lock.yaml", "pnpm"], ["package-lock.json", "npm"], ["yarn.lock", "yarn"]]) {
    const full = join(dir, file);
    if (!existsSync(full)) continue;
    let version = null;
    const raw = readFileSync(full, "utf8");
    if (format === "pnpm") version = raw.match(/lockfileVersion:\s*'?([\d.]+)'?/)?.[1] ?? null;
    if (format === "npm") version = String(readJsonc(full)?.lockfileVersion ?? "");
    lockfiles.push({ path: rel(full), format, version, bytes: statSync(full).size });
  }
}

// ------------------------------------------------------ internal edges (tsconfig paths)

const internalEdges = [];
for (const p of packages) {
  const dir = join(ROOT, p.dir === "." ? "" : p.dir);
  const ts = readJsonc(join(dir, "tsconfig.json"));
  const paths = ts?.compilerOptions?.paths;
  if (!paths) continue;
  for (const [alias, targets] of Object.entries(paths)) {
    for (const target of targets) {
      const resolved = resolve(dir, target);
      const escapesPackage = !resolved.startsWith(dir + "/");
      const owner = packages.find(
        (q) => q.dir !== p.dir && resolved.startsWith(join(ROOT, q.dir) + "/"),
      );
      internalEdges.push({
        from: p.name,
        fromDir: p.dir,
        alias,
        target,
        resolvesTo: rel(resolved),
        kind: target.includes("node_modules")
          ? "resolution-pin"
          : escapesPackage
            ? "cross-package-source"
            : /vendor/.test(target)
              ? "vendored-in-package"
              : "in-package-alias",
        toPackage: owner?.name ?? null,
      });
    }
  }
}

// ---------------------------------------------------------------- version drift

const byDep = new Map();
for (const p of packages) {
  for (const [block, deps] of [["dependencies", p.dependencies], ["devDependencies", p.devDependencies]]) {
    for (const [name, range] of Object.entries(deps)) {
      if (!byDep.has(name)) byDep.set(name, []);
      byDep.get(name).push({ package: p.name, dir: p.dir, block, range });
    }
  }
}
const drift = [...byDep.entries()]
  .filter(([, uses]) => new Set(uses.map((u) => u.range)).size > 1)
  .map(([name, uses]) => ({ dependency: name, ranges: [...new Set(uses.map((u) => u.range))], uses }))
  .sort((a, b) => b.uses.length - a.uses.length);

// ---------------------------------------------------------------- sizes

const perPackagePaths = packages.filter((p) => p.hasNodeModules).map((p) => join(ROOT, p.dir, "node_modules"));
const perPackageKb = duKb(perPackagePaths);
const perPackage = packages
  .filter((p) => p.hasNodeModules)
  .map((p) => ({
    package: p.name,
    dir: p.dir,
    manager: p.manager,
    nodeModulesMb: mb(perPackageKb.get(join(ROOT, p.dir, "node_modules")) ?? 0),
  }))
  .sort((a, b) => b.nodeModulesMb - a.nodeModulesMb);

/**
 * Own size per installed package. pnpm's top-level node_modules entries are symlinks — measuring
 * them yields 0 — so pnpm trees are measured under .pnpm/<pkg>@<ver>/node_modules/<pkg> instead.
 */
const topOwn = [];
for (const p of packages) {
  if (!p.hasNodeModules) continue;
  const nm = join(ROOT, p.dir, "node_modules");
  const targets = [];
  const pnpmDir = join(nm, ".pnpm");
  if (p.manager === "pnpm" && existsSync(pnpmDir)) {
    for (const entry of readdirSync(pnpmDir)) {
      const decoded = decodePnpmDir(entry);
      if (!decoded) continue;
      const full = join(pnpmDir, entry, "node_modules", decoded.name);
      if (existsSync(full)) targets.push({ full, ...decoded });
    }
  } else {
    const push = (name, full) => existsSync(full) && targets.push({ full, name, version: readJsonc(join(full, "package.json"))?.version ?? null });
    for (const entry of readdirSync(nm)) {
      if (entry.startsWith(".")) continue;
      if (entry.startsWith("@")) {
        for (const sub of readdirSync(join(nm, entry))) push(`${entry}/${sub}`, join(nm, entry, sub));
      } else push(entry, join(nm, entry));
    }
  }
  const sizes = duKb(targets.map((t) => t.full));
  const rows = targets
    .map((t) => ({ package: p.name, dir: p.dir, dependency: t.name, version: t.version, ownMb: mb(sizes.get(t.full) ?? 0) }))
    .sort((a, b) => b.ownMb - a.ownMb)
    .slice(0, TOP);
  topOwn.push(...rows);
}

// ---------------------------------------------------------------- orphans

const orphans = [];
(function findOrphans(dir, depth) {
  if (depth < 0) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name === "node_modules") {
      if (!existsSync(join(dir, "package.json"))) {
        const kb = duKb([join(dir, e.name)]).get(join(dir, e.name)) ?? 0;
        orphans.push({ path: rel(join(dir, e.name)), owner: rel(dir), sizeMb: mb(kb) });
      }
      continue;
    }
    if (SKIP.has(e.name)) continue;
    findOrphans(join(dir, e.name), depth - 1);
  }
})(ROOT, 3);

// ---------------------------------------------------------------- output

process.stdout.write(
  JSON.stringify(
    {
      repoRoot: ROOT,
      generatedAt: new Date().toISOString(),
      note: "Own sizes exclude transitive dependencies. Read-only collection; nothing was installed or modified.",
      packages: packages.map(({ dependencies, devDependencies, ...rest }) => ({
        ...rest,
        dependencyCount: Object.keys(dependencies).length,
        devDependencyCount: Object.keys(devDependencies).length,
        dependencies,
        devDependencies,
      })),
      lockfiles,
      internalEdges,
      drift,
      sizes: { perPackage, topOwn },
      orphans,
    },
    null,
    2,
  ) + "\n",
);
