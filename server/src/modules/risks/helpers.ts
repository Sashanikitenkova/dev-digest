import type { Risk } from '@devdigest/shared';
import {
  DEPENDENCY_MANIFESTS,
  MAX_DEPENDENCY_RISKS,
  PATH_RULES,
} from './constants.js';

/** One changed file, as the risk scan needs it. */
export interface ChangedFile {
  path: string;
  patch: string | null;
}

/**
 * Added dependency names in a `package.json` patch.
 *
 * Only ADDED lines (`+`) inside a dependency block count. The block check is
 * what stops the scan reporting every key in a reformatted manifest: a `"name":
 * "value"` pair looks identical whether it sits in `dependencies` or in
 * `scripts`, and a repo-wide reindent would otherwise light up the card.
 */
export function addedDependencies(patch: string): string[] {
  const found: string[] = [];
  let inDeps = false;

  for (const raw of patch.split('\n')) {
    // Hunk headers reset the block: a new hunk may start anywhere in the file.
    if (raw.startsWith('@@')) {
      inDeps = false;
      continue;
    }
    const line = raw.replace(/^[+\- ]/, '').trim();

    if (/^"(dependencies|devDependencies|peerDependencies|optionalDependencies)"\s*:\s*\{/.test(line)) {
      inDeps = true;
      continue;
    }
    // A closing brace at the block's own indentation ends it.
    if (inDeps && /^[}\]],?$/.test(line)) {
      inDeps = false;
      continue;
    }
    if (!inDeps || !raw.startsWith('+')) continue;

    const m = /^"([^"]+)"\s*:\s*"[^"]*"\s*,?$/.exec(line);
    if (m?.[1]) found.push(m[1]);
  }
  return [...new Set(found)];
}

/**
 * Scan a PR's changed files for risk areas.
 *
 * Every returned risk names the files that triggered it — a chip a reviewer
 * cannot trace back to a file is a chip they have to take on faith, which is
 * the opposite of what this panel is for.
 */
export function scanRisks(files: ChangedFile[]): Risk[] {
  const risks: Risk[] = [];

  for (const rule of PATH_RULES) {
    const hits = files.filter((f) => rule.pattern.test(f.path.toLowerCase()));
    if (hits.length === 0) continue;
    risks.push({
      kind: rule.kind,
      title: rule.title,
      explanation: rule.explanation,
      severity: rule.severity,
      file_refs: hits.map((f) => f.path).sort(),
    });
  }

  const deps = new Map<string, string[]>();
  for (const f of files) {
    const base = f.path.split('/').pop() ?? f.path;
    if (!DEPENDENCY_MANIFESTS.includes(base) || !f.patch) continue;
    for (const name of addedDependencies(f.patch)) {
      deps.set(name, [...(deps.get(name) ?? []), f.path]);
    }
  }
  for (const [name, refs] of [...deps].slice(0, MAX_DEPENDENCY_RISKS)) {
    risks.push({
      kind: 'new_dependency',
      title: `New dependency: ${name}`,
      explanation: `This PR adds ${name} to a package manifest. New runtime dependencies widen the supply-chain surface.`,
      severity: 'medium',
      file_refs: refs.sort(),
    });
  }

  return risks;
}
