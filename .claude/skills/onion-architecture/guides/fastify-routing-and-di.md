# Fastify Routing & Dependency Injection

This covers layer boundaries at the Fastify surface — not plugin mechanics or schema syntax (see `fastify-best-practices` for those).

## Routes are presentation-only

A `routes.ts` file parses/validates the request (Zod `params`/`body` schemas via `fastify-type-provider-zod`), calls into a `Service`, and shapes the HTTP response. It does not contain business logic, branching on domain state, or direct repository/adapter calls.

`server/src/modules/reviews/routes.ts` is the canonical example:

```ts
export default async function reviewsRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const { container } = app;
  const service = new ReviewService(container);

  app.post('/pulls/:id/review', { schema: { params: IdParams }, ... }, async (req) => {
    const { workspaceId } = await getContext(container, req);
    const body = RunRequest.parse(req.body ?? {});
    const targets = await service.resolveTargets(workspaceId, { ... });
    const { runs, reviews } = await service.runReview(workspaceId, req.params.id, targets, req.log);
    return { pr_id: req.params.id, runs, reviews };
  });
```

One `ReviewService` is constructed from `container` at plugin-registration time; the handler's job is parse → delegate → shape.

## Services depend on the `Container`, not concrete adapters

`server/src/modules/reviews/service.ts`'s constructor takes the whole `Container`:

```ts
export class ReviewService {
  private repo: ReviewRepository;
  constructor(private container: Container) {
    this.repo = new ReviewRepository(container.db);
    this.agents = container.agentsRepo;
    ...
  }
}
```

`Container` (`server/src/platform/container.ts`) exposes adapters as port-typed getters/methods — `container.git: GitClient` (sync getter), `await container.github(): Promise<GitHubClient>` (async, lazily resolves a secret then constructs `OctokitGitHubClient`), `await container.llm('openrouter'): Promise<LLMProvider>` — never the concrete classes. Every port has a matching `ContainerOverrides` field so tests inject mocks instead of touching real network/DB:

```ts
export interface ContainerOverrides {
  secrets?: SecretsProvider;
  github?: GitHubClient;
  git?: GitClient;
  llm?: Partial<Record<'openai' | 'anthropic' | 'openrouter', LLMProvider>>;
  ...
}
```

## Composition-root discipline

Only `server/src/platform/container.ts` imports from `server/src/adapters/*` (`OctokitGitHubClient`, `SimpleGitClient`, `OpenAIProvider`, `AnthropicProvider`, `RipgrepCodeIndex`, etc.). No `service.ts`, `routes.ts`, or `repository.ts` file should import a concrete adapter class directly.

## Good vs bad

**1 — where a route gets its dependencies**

- Good: `reviews/routes.ts`'s pattern above — `const { container } = app; const service = new ReviewService(container);` — the route stays thin and the service is constructed once from the container.
- Bad: a route handler doing `import { OctokitGitHubClient } from '../../adapters/github/octokit.js'` and constructing it inline to "just fetch the PR title quickly." This bypasses `ContainerOverrides` entirely — the route becomes untestable without live GitHub network access, and secret handling (`SecretsProvider`) gets duplicated ad hoc.

**2 — where business logic lives**

- Good: `reviews/service.ts` orchestrates resolve-targets → run → persist (see its own doc comment: "Orchestrates: diff → assemblePrompt → llm.completeStructured → groundFindings → persist"), while `routes.ts` only parses, calls one service method, and shapes the response.
- Bad: a route handler with inline `if (body.all) { ... } else { ... }` branching plus direct `repo.insertReview(...)` calls — this duplicates logic that belongs in `ReviewService` and can only be tested by spinning up a full Fastify instance instead of calling the service directly.
