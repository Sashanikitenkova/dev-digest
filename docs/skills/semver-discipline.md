---
name: semver-discipline
description: Require a major version bump when a diff removes or narrows public surface; flag PRs whose version bump understates the change.
type: convention
---

# semver-discipline

**Rule: classify every public-surface change as major / minor / patch, and if
the diff removes or narrows anything callers depend on, say plainly that it
requires a MAJOR bump. If the PR bumps the version at all, check that the bump
matches the change — an understated bump is itself the defect.**

| Change to public surface | Bump |
|---|---|
| Removed / renamed export, route, field, enum member | **major** |
| Required parameter added; optional made required | **major** |
| Validation narrowed (tighter enum/bounds, `.strict()`) | **major** |
| Return type gains `null`; sync becomes async | **major** |
| New optional field, new route, new export | minor |
| Validation widened (looser type, new accepted value) | minor |
| Internal refactor, docs, tests, perf with identical behavior | patch |

"It still compiles" and "the tests pass" are not evidence of a minor change —
both only cover code inside this repo. Semver describes what *callers* see.

A `0.x` version does not exempt a change from this: state the classification
anyway so the release notes can be honest about it.

## Bad — a major change shipped as a patch

```diff
- "version": "2.4.1",
+ "version": "2.4.2",

- export function getReview(id: string): Review
+ export function getReview(id: string): Review | null
```

Every caller doing `getReview(id).score` now risks a null dereference. **Report
it:** the return type gained `null`, which is a major change released as a patch.

## Good — the bump matches the change

```diff
- "version": "2.4.1",
+ "version": "3.0.0",

- export function getReview(id: string): Review
+ export function getReview(id: string): Review | null
```
