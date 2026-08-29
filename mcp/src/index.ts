import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { HttpDevDigestApi } from './adapters/http-api.js';
import type { ToolContext } from './ports.js';
import { createServer } from './server.js';

/**
 * COMPOSITION ROOT — the only file that constructs a concrete adapter.
 *
 * Everything below it depends on the `DevDigestApi` port, which is why the test
 * suite never patches `globalThis.fetch`.
 *
 * 🚨 **stdout purity.** stdout is the JSON-RPC frame stream. A single stray byte
 * corrupts it, and the symptom is a useless "server failed to connect" with no
 * error text. Nothing under `src/` writes to stdout — every diagnostic in this
 * package goes to stderr via `console.error`. The launch command must also
 * be `npm run --silent start`, or npm's own `> @devdigest/mcp@0.0.0 start`
 * banner lands on stdout ahead of the first frame.
 */

/** Where the DevDigest API lives. Set by `devdigest.mcp.json`; falls back to the dev default. */
const apiBaseUrl = process.env['DEVDIGEST_API_BASE'] ?? 'http://localhost:3001';

/** Where the studio lives — used only inside forward-leading error messages. */
const webBaseUrl = process.env['DEVDIGEST_WEB_BASE'] ?? 'http://localhost:3000';

const ctx: ToolContext = {
  api: new HttpDevDigestApi({ baseUrl: apiBaseUrl }),
  webBaseUrl,
};

// `serveStdio` takes a FACTORY: the opening exchange selects the protocol era
// and pins one instance from this factory for the connection's lifetime.
serveStdio(() => createServer(ctx), {
  onerror: (error) => console.error('[devdigest-mcp] transport error:', error),
});

console.error(`[devdigest-mcp] ready — DevDigest API at ${apiBaseUrl}`);
