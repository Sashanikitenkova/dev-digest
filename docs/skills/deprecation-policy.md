---
name: deprecation-policy
description: Require public surface to be deprecated for one release before removal; a straight deletion is a defect even when nothing in-repo uses it.
type: convention
---

# deprecation-policy

**Rule: public surface must be marked deprecated and kept working for at least
one release before it is deleted. When a diff removes something public without a
prior deprecation, report it and state the deprecate-first alternative.**

"Nothing in this repo uses it any more" is not a reason to delete it. A repo
search finds in-repo callers only — it cannot see other services, external
clients, saved integrations, or anyone pinned to the current version. Absence of
in-repo callers is absence of evidence, not evidence of absence.

A correct deprecation carries all four of:

1. a `@deprecated` marker naming the replacement,
2. the old surface still functioning (delegating to the new one),
3. the removal target named (a version or a date),
4. a changelog / release-note entry.

Removing something that was *already* deprecated with a stated target is fine —
say so and move on. The reportable case is deprecation being **skipped**.

## Bad — deleted in one step

```diff
-export function getReviewScore(id: string): number {
-  return computeScore(id);
-}
+export function getScore(id: string): number {
+  return computeScore(id);
+}
```

**Report it:** `getReviewScore` was removed without a deprecation period; any
out-of-repo caller breaks on upgrade.

## Good — both work, removal announced

```ts
/** @deprecated use `getScore`; `getReviewScore` is removed in v3.0. */
export function getReviewScore(id: string): number {
  return getScore(id);
}

export function getScore(id: string): number {
  return computeScore(id);
}
```
