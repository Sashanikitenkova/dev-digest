/* routes.ts — client-side navigation targets (router.push/replace, <Link> href,
   breadcrumb href). Single source of truth so a route-shape change touches one
   file instead of N call sites. For API resource paths, see lib/api.ts and
   lib/hooks/* — those are a separate, already-centralized concern. */

export const routes = {
  home: () => "/",
  onboarding: () => "/onboarding",
  settings: (section: string = "api-keys") => `/settings/${section}`,
  pulls: (repoId: string) => `/repos/${repoId}/pulls`,
  pull: (repoId: string, number: number | string) => `/repos/${repoId}/pulls/${number}`,
  agent: (id: string) => `/agents/${id}`,
  skills: () => "/skills",
  skill: (id: string) => `/skills/${id}`,
  conventions: () => "/conventions",
  context: () => "/context",
} as const;

/**
 * Permalink to a file (optionally a line) on GitHub. Outbound, not a client
 * route — it lives here because it is still a navigation target assembled from
 * parts, and the conventions evidence links are its only caller today.
 *
 * `line` is 1-indexed to match both the editor gutter and the `evidence_line`
 * the extractor grounds against.
 */
export function githubBlobUrl(
  repo: { owner: string; name: string; default_branch: string },
  path: string,
  line?: number | null,
  endLine?: number | null,
): string {
  const base = `https://github.com/${repo.owner}/${repo.name}/blob/${repo.default_branch}/${path}`;
  if (!line) return base;
  return endLine && endLine > line ? `${base}#L${line}-L${endLine}` : `${base}#L${line}`;
}
