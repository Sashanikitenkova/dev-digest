import type { FastifyRequest } from 'fastify';
import type { Container } from '../../platform/container.js';

export interface RequestContext {
  workspaceId: string;
  userId: string;
  /**
   * Whether the request resolved to an identified principal.
   *
   * Under the MVP `LocalNoAuthProvider` this is always true — that provider
   * resolves the seeded system user and throws if it is missing, so there is no
   * anonymous path yet. It is exposed here so route handlers can branch on
   * identity without reaching past this helper into `container.auth`, and so a
   * real provider can report an anonymous caller later without changing the
   * signature every module already depends on.
   */
  isAuthenticated: boolean;
}

/**
 * Resolve the tenancy context for a request via the AuthProvider. In MVP
 * (LocalNoAuthProvider) this always returns the default workspace + system user.
 * Every module uses this so workspace scoping is never forgotten.
 */
export async function getContext(
  container: Container,
  req: FastifyRequest,
): Promise<RequestContext> {
  const [user, workspace] = await Promise.all([
    container.auth.currentUser(req),
    container.auth.currentWorkspace(req),
  ]);
  return {
    workspaceId: workspace.id,
    userId: user.id,
    // Derived rather than provider-reported: `AuthProvider` has no
    // `isAuthenticated` member, and widening that port would touch every
    // adapter. A non-empty id is the only identity signal the port exposes.
    isAuthenticated: Boolean(user.id),
  };
}
