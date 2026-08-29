---
name: frontend-architecture
description: "React & Next.js codebase architecture and organization guide. Use when deciding where new code should live, structuring a new feature, choosing between a util/helper/service/hook, or reviewing a project's folder layout. Covers folder structure (feature-based vs type-based), component placement and splitting across files, constants placement, business logic placement, hooks/API-layer/state-management organization, Next.js App Router project structure, barrel files, and scalability/code-ownership. Does NOT cover component internals, hooks correctness, or performance (see react-best-practices) or Next.js framework mechanics like RSC boundaries and metadata (see next-best-practices)."
---

# Frontend Architecture & Code Organization

Where code lives, not what it does. This skill governs project/folder
structure, module boundaries, and layering for React + Next.js codebases.
For component-internals rules (purity, hooks correctness, performance,
a11y) see `react-best-practices`. For Next.js framework mechanics (RSC
boundaries, metadata, route handlers) see `next-best-practices`. See
[README.md](README.md) for scope, use cases, and full source list.
For folder-tree and code examples, see [examples.md](examples.md).

## Priority Levels

- **CRITICAL** — Breaks scalability or causes cross-team collisions as the codebase grows
- **HIGH** — Will cause maintainability pain or unclear ownership within months
- **MEDIUM** — Improves consistency and onboarding speed

---

## Component Placement (CRITICAL)

- Default to **feature-based structure**, not type-based (`features/checkout/`, not a global `components/` + `hooks/` + `utils/` split by kind) — a feature folder should tell a new reader what the system *does*, not that it's "a React app" (Screaming Architecture)
- Apply **colocation**: "things that change together should be located as close as reasonable" — a component's test, styles, and small local helpers live next to it, not in parallel mirrored trees
- Only promote a component to a shared/global `components/` folder once **at least two features** need it — premature sharing creates coupling before there's a real reuse case
- A feature folder's internal shape mirrors the global one at smaller scale: `api/`, `components/`, `hooks/`, `stores/`, `types/`, `utils/` — only add subfolders a feature actually needs

## Component Splitting Across Files (HIGH)

*(File/folder-level splitting only — for what makes a component too large internally, see `react-best-practices`.)*

- One component = one file; give reusable components their own folder (`Component/index.tsx` + colocated `Component.test.tsx`)
- Split a component into its own file once it has an independent reason to change from its parent, not just because the parent file is long
- Small, single-use presentational fragments can stay colocated as internal (non-exported) helpers in the same file as their parent

## Constants (HIGH)

- App-wide constants (routes, feature flags, breakpoints) live in a dedicated `constants/` (or `config/`) location, one file per concern (`routes.ts`, `feature-flags.ts`) rather than one giant `constants.ts`
- Constants used by exactly one feature live inside that feature folder, not promoted to the global constants location
- Type constants (`as const`, enums, or union types) so misuse is caught at compile time
- Never put secrets or private API keys in client-side constants/config — anything referenced by client code ships in the bundle

## Utils vs. Helpers vs. Services vs. Hooks (CRITICAL)

No framework enforces this distinction — pick one convention and apply it consistently. Decision table:

| Kind | Depends on React? | Has state? | Where it lives |
|---|---|---|---|
| **Util / lib** | No | No — pure, stateless, same input → same output | `utils/` or `lib/`, colocated to feature if feature-only |
| **Helper** | No | No | Same as util — many teams use "helper" and "util" interchangeably; if you distinguish them, use "helper" for small formatting/glue functions and "util" for general-purpose pure logic, and document the split once so it doesn't drift |
| **Service** | No | May hold config/instances (e.g. an API client), but no React state | `services/` or `api/` — business/domain logic that must be usable outside a component (script, test, another framework) |
| **Custom hook** | Yes | Yes — wraps `useState`/`useEffect`/other hooks | `hooks/`, one hook per file |

- If logic needs `useState`, `useEffect`, `useContext`, or any other hook, it belongs in a **custom hook**, not a util
- If logic must be callable from outside a React component (a script, a test, a non-React consumer) it belongs in a **service**, not a hook
- A service can be called from inside a custom hook (hook wraps service + adds React state), but a hook should never be called from a service

## Business Logic Placement (CRITICAL)

- Business logic does not live in the component body — a component's only job is rendering UI from props/state
- Extract logic to a hook (stateful) or a service (framework-agnostic) so it's testable without mounting a component and reusable independent of the UI framework
- Prefer dependency injection (pass collaborators/config as arguments) over hardcoding, so business logic can be unit-tested in isolation
- Container components own data-fetching and business-logic orchestration; presentational components only receive props and render

## Hooks Organization (HIGH)

- One hook per file; file name matches hook name (`use-auth.ts` exports `useAuth`)
- Feature-only hooks live inside that feature's `hooks/`; hooks used by 2+ features move to the shared `hooks/`
- For data-fetching hooks built on TanStack Query, split by responsibility (`queries/` vs `mutations/`, or one file per entity) rather than one large hooks file — this keeps query keys and invalidation logic easy to find
- Don't create a hook whose only job is wrapping a single `useEffect` as a "lifecycle" convenience — that hides what's actually happening without adding reuse value

## API / Service Layer (HIGH)

- Centralize API calls behind a layer instead of calling `fetch`/`axios` directly inside components or hooks — an **adapter** layer talks to the network, a **service** layer adds business rules on top, hooks/UI consume the service
- Services return data only — loading/error/empty state handling stays in the hook or container component, not the service
- When using TanStack Query (or similar), service functions become the query/mutation functions passed to the library — keeps API logic organized independent of caching concerns

## State Management Organization (HIGH)

- Colocate state with the component that owns it by default; only lift or centralize state once multiple unrelated components need it
- When using Redux Toolkit or Zustand, organize state **by feature** ("slices" owned by the feature that uses them), not one global flat store file — each feature folder owns its slice and doesn't reach into another feature's slice directly
- Filter/pagination/search state that should survive a refresh or be shareable via link belongs in URL search params, not client state
- Prop-drilling one or two levels is preferable to introducing global state/Context purely to avoid it — reach for Context/global state only when drilling crosses an actual feature boundary

## Feature Modules & Screaming Architecture (MEDIUM)

- A codebase's top-level structure should "scream" the domain (`features/checkout`, `features/inbox`) — not the framework (`components/`, `containers/`, `hocs/`)
- Each feature folder is a vertical slice: it owns its own `api/`, `components/`, `hooks/`, `types/` rather than being scattered across parallel type-based trees
- Two entry points into the codebase are fine and expected: navigate by **page/route** or by **feature** — they should end up pointing at the same code

## Next.js App Router Structure (HIGH)

- Next.js is unopinionated about file organization outside routing conventions — files are **safely colocated** inside `app/` route segments by default; a folder only becomes routable when it contains `page.tsx` or `route.tsx`
- Use **private folders** (`_components/`, `_lib/`) inside a route segment to hold route-specific code you want visually and semantically separated from routing files, without needing route groups
- Use **route groups** (`(marketing)`, `(app)`) to organize routes into sections without affecting the URL — not to colocate non-routable code (that's what private folders are for)
- Shared, cross-route code (design-system components, app-wide hooks) lives in `src/components`, `src/lib`, `src/hooks` outside `app/`; route/feature-specific code stays colocated inside the relevant route segment
- Push `'use client'` as far down the tree as possible ("colocating interactivity") — keep layout shells, data fetching, and static content as Server Components; isolate interactive leaves as Client Components

## Barrel Files (MEDIUM)

- Do not use barrel `index.ts` re-export files for internal application code — they slow dev-server startup and cold builds by force-loading every module in the barrel, encourage circular imports, and make "Go to Definition" land on the barrel instead of the real file
- A barrel file is appropriate at the **public boundary of a published/shared package** (e.g. this repo's vendored `@devdigest/ui`) — one intentional entry point for external consumers
- Inside application code, import directly from the file that defines what you need

## Scalability, Maintainability, Code Ownership (MEDIUM)

- Cap folder nesting at roughly 3–4 levels deep — beyond that, split into a new top-level feature instead of nesting further
- Treat each feature folder as an implicit ownership boundary: a PR that only touches one feature folder is easy to review and route to the right owner; a PR that touches many feature folders at once is a signal the boundary is wrong
- Start minimal (`components/`, `hooks/`, `utils/` or `lib/`) and let the codebase's actual needs justify each new top-level folder — don't scaffold a full enterprise structure for a small app
- Enforce structure decisions once agreed (lint rule, code review checklist, or a project-structure linter) — an unenforced convention decays as the team grows
