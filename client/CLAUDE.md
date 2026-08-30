# CLAUDE.md — client (`@devdigest/web`)

Next.js 15 studio: import repos, browse PRs, run/read AI reviews, author
agents. App Router + React Server/Client components, data via TanStack Query
hooks over the Fastify API. See root [`CLAUDE.md`](../CLAUDE.md) for
cross-package conventions.

## Stack

Next.js 15 (App Router), React 19, TanStack Query, Tailwind 4, `next-intl`,
`recharts`, `mermaid`, `react-markdown`.

## Commands

`pnpm dev` (:3000) · `pnpm test` (vitest + jsdom, `fetch` mocked) · `pnpm typecheck`.

## Map

`src/app/**/page.tsx` — thin routes; feature logic lives in colocated
`_components/<Name>/` folders, each with its own `*.test.tsx`. `src/lib/hooks/*`
— one data hook per API resource, on top of `src/lib/api.ts`
(`NEXT_PUBLIC_API_BASE`). `src/vendor/ui` — vendored `@devdigest/ui` primitives.
`src/vendor/shared` — vendored Zod contracts.

## Non-default conventions

- `src/vendor/shared` and `src/vendor/ui` are committed **copies**, not real
  package deps — never `pnpm add @devdigest/shared` or `@devdigest/ui`; edit
  the vendored copy directly or resync it from its source.
- Cross-cutting chrome (nav, breadcrumbs, `g`-then-key shortcuts) lives in
  `src/components/app-shell`, not per-page.
- **Client-first by design, not by default.** Every route is `"use client"`
  top-to-bottom — there's no Server Component data fetching anywhere in
  `client/`. This is deliberate: the app talks to exactly one local Fastify
  API purely through TanStack Query hooks (`src/lib/hooks/*`), so mixing
  server- and client-fetched data would add real complexity (two caching
  models, hydration mismatches) for no payoff on a local-first internal
  tool. Don't "fix" a page to a Server Component without discussing it
  first — it's a considered trade-off, not drift.

## Do-not-touch

`.next/`, `node_modules/`, vendored `src/vendor/**` (unless deliberately
resyncing from source).

## Read when…

| Doc | Read when |
|---|---|
| [`README.md`](README.md) | UI route map / which API endpoints a page uses |
| [`docs/README.md`](docs/README.md) | digging into a specific subsystem — currently a stub |
| [`specs/README.md`](specs/README.md) | implementing a feature — currently a stub |
| [`INSIGHTS.md`](INSIGHTS.md) | before changing a long-standing convention, or something behaves surprisingly |
| [`../e2e/README.md`](../e2e/README.md) | the real browser journeys behind these routes |
