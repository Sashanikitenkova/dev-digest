/* nav.ts — sidebar nav groups + keyboard shortcut registry.
   hrefs use :repoId token; the web app fills it from the active repo. */
import type { IconName } from "./icons";

export interface NavItemDef {
  key: string;
  label: string;
  icon: IconName;
  /** Route template; :repoId is replaced with the active repo id by the app. */
  href: string;
  /** Optional g-nav shortcut suffix (e.g. "p" → g then p). */
  gKey?: string;
  badge?: string;
}

export interface NavGroup {
  section: string;
  items: NavItemDef[];
}

export const NAV: NavGroup[] = [
  {
    section: "WORKSPACE",
    items: [
      { key: "pulls", label: "Pull Requests", icon: "GitPullRequest", href: "/repos/:repoId/pulls", gKey: "p" },
      // Project Context sits in WORKSPACE, not SKILLS LAB: the documents are
      // the repository's own files, shared by every agent and skill, rather
      // than something authored in the lab.
      // Repo-scoped like `pulls`: the documents ARE one repository's files, so
      // the repo belongs in the URL rather than being read from the ambient
      // active-repo state — that is what makes the link shareable and what lets
      // two repos show their own listing.
      // `gKey: "x"` because p/s/a/c and "," are already taken and "conteXt" is
      // the only free mnemonic — "d" would read as the bare Dismiss-finding key.
      { key: "context", label: "Project Context", icon: "FileText", href: "/repos/:repoId/context", gKey: "x" },
    ],
  },
  {
    // Skills come before Agents: a skill is the reusable unit an agent links to,
    // so the list reads authoring-order (write the rule → attach it to an agent).
    section: "SKILLS LAB",
    items: [
      { key: "skills", label: "Skills", icon: "Sparkles", href: "/skills", gKey: "s" },
      { key: "agents", label: "Agents", icon: "Cpu", href: "/agents", gKey: "a" },
      // Conventions sits last in the group: it FEEDS the other two (extract a
      // house-rule → merge into a Skill → link to an Agent), so it reads as the
      // upstream source rather than a third peer.
      { key: "conventions", label: "Conventions", icon: "ListChecks", href: "/conventions", gKey: "c" },
      // Eval Dashboard closes the loop the other three open: author a skill,
      // attach it to an agent, then measure whether that changed anything.
      // `gKey: "e"` — p/s/a/c/x and "," are taken, and "e" is free.
      { key: "eval", label: "Eval Dashboard", icon: "Gauge", href: "/eval", gKey: "e" },
    ],
  },
];

export const SETTINGS_ITEM: NavItemDef = {
  key: "settings",
  label: "Settings",
  icon: "Settings",
  href: "/settings/api-keys",
  gKey: ",",
};

export const SETTINGS_SECTIONS = [
  { key: "api-keys", label: "API Keys" },
  { key: "models", label: "Feature Models" },
] as const;

/** Keyboard shortcut registry. Wiring is finalized by A6. */
export interface ShortcutDef {
  keys: string;
  label: string;
  group: "Navigation" | "Findings" | "Actions" | "Global";
}

export const SHORTCUTS: ShortcutDef[] = [
  { keys: "⌘K", label: "Open command palette", group: "Global" },
  { keys: "?", label: "Show keyboard shortcuts", group: "Global" },
  { keys: "g p", label: "Go to Pull Requests", group: "Navigation" },
  { keys: "g s", label: "Go to Skills", group: "Navigation" },
  { keys: "g a", label: "Go to Agents", group: "Navigation" },
  { keys: "g c", label: "Go to Conventions", group: "Navigation" },
  { keys: "g x", label: "Go to Project Context", group: "Navigation" },
  { keys: "g e", label: "Go to Eval Dashboard", group: "Navigation" },
  { keys: "j / k", label: "Next / previous finding", group: "Findings" },
  { keys: "a", label: "Accept finding", group: "Findings" },
  { keys: "d", label: "Dismiss finding", group: "Findings" },
];

/** Resolve an :repoId-templated href against the active repo id. */
export function resolveHref(href: string, repoId: string | null | undefined): string {
  if (!href.includes(":repoId")) return href;
  return href.replace(":repoId", repoId ?? "_");
}
