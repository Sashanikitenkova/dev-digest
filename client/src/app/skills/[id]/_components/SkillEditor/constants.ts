import type { IconName } from "@devdigest/ui";

/** Editor tabs. Evals/Stats are deliberately deferred — see the feature plan. */
export const TABS: { key: string; labelKey: string; icon: IconName }[] = [
  { key: "config", labelKey: "editor.tabs.config", icon: "Settings" },
  { key: "preview", labelKey: "editor.tabs.preview", icon: "Eye" },
  { key: "versions", labelKey: "editor.tabs.versions", icon: "History" },
];

/** Tab keys the /skills/:id route accepts in `?tab=`. */
export const VALID_TABS = TABS.map((t) => t.key);
