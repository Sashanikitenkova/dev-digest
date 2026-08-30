import type { IconName } from "@devdigest/ui";

/** Editor tab descriptor. `labelKey` resolves under the `agents` namespace. */
export interface EditorTab {
  key: string;
  labelKey: string;
  icon: IconName;
}

/** Editor tabs. Stats/CI are still deferred to later lessons. */
export const TABS: readonly EditorTab[] = [
  { key: "config", labelKey: "editor.tabs.config", icon: "Settings" },
  { key: "skills", labelKey: "editor.tabs.skills", icon: "Sparkles" },
  // Context sits after Skills because an agent inherits documents THROUGH its
  // skills as well as attaching its own — the order reads the way the prompt
  // is assembled.
  { key: "context", labelKey: "editor.tabs.context", icon: "FileText" },
  // Evals last: it measures the three tabs before it, so the order reads
  // "configure the agent → then check what that configuration scores".
  { key: "evals", labelKey: "editor.tabs.evals", icon: "FlaskConical" },
];

/**
 * Tab keys the `/agents/:id` route accepts in `?tab=`.
 *
 * DERIVED from `TABS`, never written out by hand. The route rejects an unknown
 * `?tab=` and falls back to `config`, so a whitelist that lags behind this list
 * makes the missing tab silently unreachable: the click sets the query param
 * and the very next render throws it away. That is exactly what happened when
 * `context` was added here while `agents/[id]/page.tsx` kept its own
 * `["config", "skills"]` literal. Deriving it means a new tab is routable the
 * moment it exists. Same shape as `SkillEditor/constants.ts`.
 */
export const VALID_TABS: readonly string[] = TABS.map((t) => t.key);
