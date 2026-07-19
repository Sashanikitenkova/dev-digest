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
} as const;
