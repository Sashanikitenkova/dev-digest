import { z } from 'zod';

/**
 * COMPOSITION-ROOT ring — the one place environment is read and validated.
 *
 * Mirrors the house pattern in `server/src/platform/config.ts`: a zod schema
 * over the raw env, parsed once at startup into a typed object. Feature code
 * never touches `process.env`; it receives `McpConfig` through `ToolContext`.
 *
 * The point of validating here is FAIL-FAST. Before this existed, a malformed
 * `DEVDIGEST_API_BASE` sailed through startup and only surfaced at the first
 * `fetch`, as a confusing per-tool error rather than a boot failure.
 *
 * 🚨 stdout purity: nothing in this file may write to stdout — it is the
 * JSON-RPC frame channel. `loadConfig` THROWS on bad input and lets the
 * composition root decide how to report it (stderr) and exit. That split is
 * also what keeps the invalid-input case testable: a `process.exit()` in here
 * would take the vitest worker down with it.
 */

/**
 * Trailing slashes are stripped because every caller joins paths with a leading
 * `/`. Note `z.url()` does NOT do this itself — `http://host:3001/` validates
 * happily and would produce `//pulls/...` downstream.
 */
const BaseUrl = z.url().transform((value) => value.replace(/\/+$/, ''));

const EnvSchema = z.object({
  DEVDIGEST_API_BASE: BaseUrl.default('http://localhost:3001'),
  DEVDIGEST_WEB_BASE: BaseUrl.default('http://localhost:3000'),
});

export interface McpConfig {
  /** Where the DevDigest API lives. No trailing slash. */
  apiBaseUrl: string;
  /** Where the studio lives — used only inside forward-leading error messages. */
  webBaseUrl: string;
}

/** Thrown when the environment is unusable. Carries a model-free, human message. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Parse and validate the environment. Throws `ConfigError` with every offending
 * variable named — not just the first — so one restart surfaces every mistake.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const parsed = EnvSchema.safeParse({
    // Bracket access is required: tsconfig sets `noUncheckedIndexedAccess`.
    DEVDIGEST_API_BASE: env['DEVDIGEST_API_BASE'],
    DEVDIGEST_WEB_BASE: env['DEVDIGEST_WEB_BASE'],
  });

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(`Invalid DevDigest MCP environment:\n${details}`);
  }

  return {
    apiBaseUrl: parsed.data.DEVDIGEST_API_BASE,
    webBaseUrl: parsed.data.DEVDIGEST_WEB_BASE,
  };
}
