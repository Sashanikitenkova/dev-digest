import 'dotenv/config';
import { z } from 'zod';
import { homedir } from 'node:os';
import { join, isAbsolute, resolve } from 'node:path';

/**
 * Central, zod-validated environment config. Loaded once at startup.
 *
 * NOTE: secret keys (OPENAI/ANTHROPIC/OPENROUTER/GITHUB_TOKEN) are deliberately
 * NOT in this schema. Feature code must access secrets through SecretsProvider,
 * never via process.env or AppConfig — the SecretsProvider is the one chokepoint
 * that reads process.env directly (see adapters/secrets/local.ts). Listing them
 * here would be dead config that never reaches AppConfig.
 */
const EnvSchema = z.object({
  DATABASE_URL: z
    .string()
    .default('postgres://devdigest:devdigest@localhost:5432/devdigest'),
  // Memory/RAG embeddings run on OpenAI (text-embedding-3-small, 1536-dim — the
  // pgvector columns are locked to that). Default OFF so the app makes ZERO
  // OpenAI requests; set EMBEDDINGS_ENABLED=true to turn memory retrieval on.
  EMBEDDINGS_ENABLED: z.string().optional(),
  // repo-intel facade (Tier 1). Default ON — reviews get repo skeleton +
  // callers context. Set REPO_INTEL_ENABLED=false to opt out, in which case
  // every consumer degrades to ripgrep-identical behavior (acceptance #10).
  // Note: even when on, sections only populate once the repo is indexed; an
  // unindexed repo degrades gracefully. Per-agent override: agents.repo_intel.
  REPO_INTEL_ENABLED: z.string().optional(),
  // SPEC-01 — comma-separated repo-root directory names walked for project
  // context documents. Unset → `specs,docs,insights`.
  DEVDIGEST_CONTEXT_ROOTS: z.string().optional(),
  // Global per-IP request budget. The studio is ONE localhost IP and one
  // user, and its pollers (repo-intel status every 1.5 s while indexing, the
  // two runs pollers every 4 s during a review) spend ~70/min before anyone
  // clicks anything — so the 120 this used to be left too little headroom and
  // an ordinary burst of UI writes got a 429.
  DEVDIGEST_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(600),
  API_PORT: z.coerce.number().int().default(3001),
  WEB_PORT: z.coerce.number().int().default(3000),
  DEVDIGEST_CLONE_DIR: z.string().optional(),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // `.env` (and .env.example) ship `LOG_LEVEL=` empty; an empty string is not a
  // valid enum member, so coerce '' → undefined to fall through to the default.
  LOG_LEVEL: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  ),
});

export type AppConfig = {
  databaseUrl: string;
  apiPort: number;
  webPort: number;
  /** Absolute path where repos are cloned (~/.devdigest/workspace by default). */
  cloneDir: string;
  /** Absolute path to the writable secrets store (BYO keys from the UI). */
  secretsPath: string;
  nodeEnv: 'development' | 'test' | 'production';
  logLevel: string;
  /** Allowed CORS origin for the Next.js dev server. */
  webOrigin: string;
  /** Global per-IP requests per minute. See DEVDIGEST_RATE_LIMIT_MAX. */
  rateLimitMax: number;
  /** Whether memory/RAG embeddings (OpenAI) are enabled. Default false. */
  embeddingsEnabled: boolean;
  /**
   * Whether the repo-intel facade (Tier 1: phantom-gate, callers-in-prompt) is
   * active. Default ON — set REPO_INTEL_ENABLED=false to opt out, in which case
   * every facade method returns its degraded result (`[]`) so consumers behave
   * EXACTLY like the ripgrep-only baseline.
   */
  repoIntelEnabled: boolean;
  /**
   * Repo-root directory names walked for project-context documents (SPEC-01).
   * Default `['specs','docs','insights']`; override with a comma-separated
   * `DEVDIGEST_CONTEXT_ROOTS`.
   *
   * PROCESS-LEVEL, not per-workspace — a deliberate deviation from the spec's
   * Open questions, which assumed a workspace setting. It follows the
   * `REPO_INTEL_ENABLED` precedent: the roots describe how THIS deployment lays
   * its repositories out, the same way the clone directory does, and a
   * per-workspace override would need a settings row, a UI and a migration to
   * express a value that is identical for every workspace on a local-first tool.
   * Revisit only if a single install genuinely reviews repos with incompatible
   * layouts.
   *
   * Each entry is validated as ONE `[A-Za-z0-9._-]+` path segment, so a hostile
   * or fat-fingered env cannot smuggle `..`, `/` or a glob into the walker.
   */
  contextRoots: string[];
};

/** Roots walked when `DEVDIGEST_CONTEXT_ROOTS` is unset or yields nothing valid. */
const DEFAULT_CONTEXT_ROOTS = ['specs', 'docs', 'insights'];

/** A root must be a single, boring path segment — no separator, no traversal,
    no glob metacharacter. Anything else is dropped rather than escaped. */
const CONTEXT_ROOT_RE = /^[A-Za-z0-9._-]+$/;

function parseContextRoots(raw: string | undefined): string[] {
  if (!raw) return [...DEFAULT_CONTEXT_ROOTS];
  const roots = raw
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r.length > 0 && r !== '.' && r !== '..' && CONTEXT_ROOT_RE.test(r));
  // Every entry filtered out = a misconfiguration; fall back rather than walk
  // the whole clone, which is what an empty root list would otherwise mean.
  return roots.length > 0 ? [...new Set(roots)] : [...DEFAULT_CONTEXT_ROOTS];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.parse(env);
  const cloneDirRaw =
    parsed.DEVDIGEST_CLONE_DIR ?? join(homedir(), '.devdigest', 'workspace');
  const cloneDir = isAbsolute(cloneDirRaw) ? cloneDirRaw : resolve(process.cwd(), cloneDirRaw);
  return {
    databaseUrl: parsed.DATABASE_URL,
    apiPort: parsed.API_PORT,
    webPort: parsed.WEB_PORT,
    cloneDir,
    secretsPath: join(homedir(), '.devdigest', 'secrets.json'),
    nodeEnv: parsed.NODE_ENV,
    logLevel: parsed.LOG_LEVEL ?? (parsed.NODE_ENV === 'test' ? 'silent' : 'info'),
    webOrigin: `http://localhost:${parsed.WEB_PORT}`,
    rateLimitMax: parsed.DEVDIGEST_RATE_LIMIT_MAX,
    embeddingsEnabled: parsed.EMBEDDINGS_ENABLED === 'true',
    repoIntelEnabled: parsed.REPO_INTEL_ENABLED !== 'false',
    contextRoots: parseContextRoots(parsed.DEVDIGEST_CONTEXT_ROOTS),
  };
}
