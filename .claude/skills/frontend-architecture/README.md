# frontend-architecture

**Version:** 1.0.0

A skill for React + Next.js **codebase architecture and organization** —
where code lives, not what it does or how fast it runs.

## Purpose & Focus

This skill answers "where should this go?" and "what should this be called?"
questions for a React/Next.js codebase: folder structure, feature vs.
type-based organization, component placement and splitting across files,
constants placement, the util/helper/service/hook distinction, business
logic placement, hooks/state/API-layer organization, Next.js App Router
project structure, barrel files, and scalability/code-ownership.

It deliberately excludes component internals (purity, memoization
correctness, JSX patterns, performance, accessibility) and Next.js
framework mechanics (RSC boundary rules, metadata, route handlers, image/
font optimization) — those are owned by sibling skills. See
[Relation to Other Skills](#relation-to-other-skills) below.

The rules live in [SKILL.md](SKILL.md); good/bad folder-tree and code
examples live in [examples.md](examples.md).

## What It Covers

- Component placement — feature-based vs. type-based structure, colocation, when to promote a component to shared
- Component splitting across files/folders (not internal component design)
- Constants placement — dedicated vs. feature-scoped, typing, secrets
- Utils vs. helpers vs. services vs. hooks — a decision table
- Business logic placement — out of component bodies, into hooks/services, testable via dependency injection
- Hooks organization — one hook per file, feature-local vs. shared, TanStack Query conventions
- API / service layer — adapter → service → hook/UI layering
- State management organization — colocation-first, feature-owned slices, URL state
- Feature modules & Screaming Architecture
- Next.js App Router project structure — colocation, private folders, route groups, `'use client'` placement
- Barrel files — when they help vs. hurt
- Scalability, maintainability, and code-ownership boundaries

## Use Cases

- Starting a new feature and unsure which folder new files belong in
- Reviewing a PR that adds a new top-level folder or changes project layout
- Deciding whether a piece of logic should be a util, a service, or a custom hook
- Onboarding to an unfamiliar React/Next.js codebase and needing a mental model of its structure
- Auditing an existing codebase for structural drift (type-based sprawl, oversized shared folders, barrel-file bloat)
- Setting up conventions for a new project or module before code accumulates

## Relation to Other Skills

| Skill | Focus | Boundary with this skill |
|---|---|---|
| [`react-best-practices`](../react-best-practices/SKILL.md) | Component internals: purity, hooks correctness, memoization, JSX patterns, performance, accessibility | This skill stops at "which file/folder" — defers to `react-best-practices` for what happens *inside* a component or hook |
| [`next-best-practices`](../next-best-practices/SKILL.md) | Next.js framework mechanics: RSC boundary rules, async APIs, metadata, route handlers, image/font optimization, bundling | This skill covers *where* Next.js-adjacent code lives (App Router project structure, colocation); `next-best-practices` covers *how* to use the framework's APIs correctly |

If a question is about whether a `useEffect` is misused, that's
`react-best-practices`. If it's about whether `params` needs to be
awaited, that's `next-best-practices`. If it's about whether a hook
should live in a feature folder or the shared `hooks/` folder, that's
this skill.

## Version History

- **1.0.0** — 2026-07-18 — Initial release. Twelve rule sections in
  `SKILL.md`, folder-tree examples in `examples.md`, full source list
  below.

## References

All sources consulted while compiling this skill. Grouped by type;
every rule in `SKILL.md` traces back to at least one of these.

### Official Documentation

- React – Reusing Logic with Custom Hooks: https://react.dev/learn/reusing-logic-with-custom-hooks
- React – Rules of Hooks: https://react.dev/reference/rules/rules-of-hooks
- React (legacy docs) – File Structure FAQ: https://legacy.reactjs.org/docs/faq-structure.html
- Next.js – Project Structure: https://nextjs.org/docs/app/getting-started/project-structure
- Next.js – Project Organization and File Colocation: https://nextjs.org/docs/app/building-your-application/routing/colocation
- Next.js – Server and Client Components: https://nextjs.org/docs/app/getting-started/server-and-client-components
- Next.js – Fetching Data: https://nextjs.org/docs/app/getting-started/fetching-data
- Next.js – `src` Folder Convention: https://nextjs.org/docs/app/api-reference/file-conventions/src-folder
- Redux – Code Structure FAQ: https://redux.js.org/faq/code-structure
- Redux – Redux Toolkit App Structure (Essentials, Part 2): https://redux.js.org/tutorials/essentials/part-2-app-structure
- Nx – Code Ownership: https://nx.dev/docs/concepts/decisions/code-ownership
- Nx – Why Monorepos: https://nx.dev/docs/concepts/decisions/why-monorepos

### Community & Expert Sources

- bulletproof-react – Project Structure: https://github.com/alan2207/bulletproof-react/blob/master/docs/project-structure.md
- bulletproof-react – Project Standards: https://github.com/alan2207/bulletproof-react/blob/master/docs/project-standards.md
- bulletproof-react (repository): https://github.com/alan2207/bulletproof-react
- Robin Wieruch – React Folder Structure Best Practices [2026]: https://www.robinwieruch.de/react-folder-structure/
- Josh W. Comeau – Delightful React File/Directory Structure: https://www.joshwcomeau.com/react/file-structure/
- Kent C. Dodds – Colocation: https://kentcdodds.com/blog/colocation
- Kent C. Dodds – When to Break Up a Component into Multiple Components: https://kentcdodds.com/blog/when-to-break-up-a-component-into-multiple-components
- profy.dev – Screaming Architecture: Evolution of a React Folder Structure: https://dev.to/profydev/screaming-architecture-evolution-of-a-react-folder-structure-4g25
- profy.dev – Popular React Folder Structures and Screaming Architecture: https://profy.dev/article/react-folder-structure
- profy.dev – Path to a Clean(er) React Architecture, Part 6 (Business Logic Separation & Dependency Injection): https://profy.dev/article/react-architecture-business-logic-and-dependency-injection
- profy.dev – Path to a Clean(er) React Architecture, Part 8 (React Query): https://profy.dev/article/react-architecture-tanstack-query
- TkDodo (Dominik Dorfmeister, TanStack Query maintainer) – Please Stop Using Barrel Files: https://tkdodo.eu/blog/please-stop-using-barrel-files
- LogRocket – Optimize React Apps Using a Multi-Layered Structure: https://blog.logrocket.com/optimize-react-apps-using-a-multi-layered-structure/
- Developer Way – React Components Composition: How to Get It Right: https://www.developerway.com/posts/components-composition-how-to-get-it-right
- itnext.io (Juntao Qiu) – The Right Way to Place Business Logic in Your React Application: https://itnext.io/the-right-way-to-place-business-logic-in-your-react-application-8bf16145f48d
- TanStack Query – Project Structure Suggestions (GitHub Discussion): https://github.com/TanStack/query/discussions/3017
- Semaphore – How To Organize Constants in a Dedicated Layer in JavaScript: https://semaphore.io/blog/constants-layer-javascript
- Cheesecake Labs – Rethinking Atomic Design in React Projects: https://cheesecakelabs.com/blog/rethinking-atomic-design-react-projects/
