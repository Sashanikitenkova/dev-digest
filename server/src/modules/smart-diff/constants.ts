import type { SmartDiffRole } from '@devdigest/shared';

/**
 * Smart-diff tunables. EVERY pattern and threshold lives here — `classify.ts`
 * holds the matching loop and nothing else, so re-tuning the taxonomy for a
 * different stack is a data edit, not a logic edit.
 */

/** Render order for the groups: business logic first, generated output last. */
export const SMART_DIFF_ROLE_ORDER: readonly SmartDiffRole[] = ['core', 'wiring', 'boilerplate'];

/** Nothing matched → the file is assumed to carry real logic. */
export const DEFAULT_ROLE: SmartDiffRole = 'core';

/** One classification rule. Patterns are matched against a normalized POSIX path. */
export interface ClassificationRule {
  role: SmartDiffRole;
  /** Why this rule exists — surfaced in test failures, not in the API. */
  label: string;
  test: RegExp;
}

/**
 * Ordered rules — FIRST MATCH WINS, and boilerplate is listed before wiring on
 * purpose: `dist/index.js` is generated output that happens to be named like a
 * barrel, and the generated-ness is the fact a reviewer cares about.
 *
 * Never give these the `g` flag: a global RegExp carries `lastIndex` between
 * calls and would match every other invocation.
 */
export const CLASSIFICATION_RULES: readonly ClassificationRule[] = [
  // ---- boilerplate: machine-written, review by diffstat only ----
  {
    role: 'boilerplate',
    label: 'dependency lockfile',
    test: /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|cargo\.lock|poetry\.lock|composer\.lock|gemfile\.lock|go\.sum|pipfile\.lock)$/i,
  },
  {
    role: 'boilerplate',
    label: 'build output directory',
    test: /(^|\/)(dist|build|out|coverage|\.next|\.turbo|target)\//i,
  },
  {
    role: 'boilerplate',
    label: 'test snapshot',
    test: /(^|\/)__snapshots__\/|\.snap$/i,
  },
  {
    role: 'boilerplate',
    label: 'generated source',
    test: /(^|\/)(generated|__generated__)\/|\.generated\.[a-z0-9]+$/i,
  },
  {
    role: 'boilerplate',
    label: 'minified asset or source map',
    test: /\.min\.(js|css)$|\.map$/i,
  },
  {
    role: 'boilerplate',
    label: 'database migration',
    test: /(^|\/)(migrations|drizzle)\//i,
  },

  // ---- wiring: hooks the core into the app ----
  {
    role: 'wiring',
    label: 'barrel / index file',
    test: /(^|\/)index\.(ts|tsx|js|jsx|mjs|cjs)$/i,
  },
  {
    role: 'wiring',
    label: 'route registration',
    test: /(^|\/)(routes?|router)\.(ts|tsx|js|jsx)$/i,
  },
  {
    role: 'wiring',
    label: 'app bootstrap / DI container',
    test: /(^|\/)(container|bootstrap|registry|providers?|main|app|server)\.(ts|tsx|js|jsx)$/i,
  },
  {
    role: 'wiring',
    label: 'tool config file',
    test: /\.config\.(ts|js|mjs|cjs|json|yaml|yml)$/i,
  },
  {
    role: 'wiring',
    label: 'package manifest or tsconfig',
    test: /(^|\/)(package\.json|tsconfig[^/]*\.json|jsconfig[^/]*\.json|composer\.json|cargo\.toml|pyproject\.toml|go\.mod)$/i,
  },
  {
    role: 'wiring',
    label: 'CI / container / repo config',
    test: /(^|\/)(\.github|\.circleci|\.husky)\/|(^|\/)(dockerfile|docker-compose\.ya?ml|\.dockerignore|\.gitignore|\.editorconfig|\.npmrc|\.nvmrc)$/i,
  },
  {
    role: 'wiring',
    label: 'app-level config module',
    test: /(^|\/)config\.(ts|tsx|js|jsx)$/i,
  },
];

/**
 * A PR above this many changed lines gets a split suggestion. 400 is roughly
 * where a single sitting stops being enough — big enough that a normal feature
 * PR doesn't trip it, small enough that a genuine mega-PR always does.
 */
export const LARGE_PR_LINES = 400;

/** Cap on suggested splits — past a handful the suggestion stops being actionable. */
export const MAX_PROPOSED_SPLITS = 4;

/** A split is only worth proposing if it holds at least this many files. */
export const MIN_FILES_PER_SPLIT = 2;
