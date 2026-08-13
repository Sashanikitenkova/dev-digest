import type { IconName } from "@devdigest/ui";

/** Editor tabs. Evals is still deferred — it needs the L06 eval pipeline. */
export const TABS: { key: string; labelKey: string; icon: IconName }[] = [
  { key: "config", labelKey: "editor.tabs.config", icon: "Settings" },
  { key: "preview", labelKey: "editor.tabs.preview", icon: "Eye" },
  { key: "stats", labelKey: "editor.tabs.stats", icon: "Activity" },
  { key: "versions", labelKey: "editor.tabs.versions", icon: "History" },
];

/** Tab keys the /skills/:id route accepts in `?tab=`. */
export const VALID_TABS = TABS.map((t) => t.key);
