import { ProjectContextView } from "./_components/ProjectContextView";

/* Route: /repos/:repoId/context (Workspace · Project Context). Thin route entry
   — the view, its styles and helpers are colocated under _components/. The
   repo id is read from the route segment by the view itself; there is no
   repos/[repoId]/layout.tsx in this app, matching the pulls routes. */
export default function ProjectContextPage() {
  return <ProjectContextView />;
}
