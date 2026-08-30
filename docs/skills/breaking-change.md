---
name: breaking-change
description: Flag any change that removes or renames part of a public API contract existing callers depend on.
type: convention
---

# breaking-change

**Rule: if this diff removes, renames, or re-types anything a caller outside the
changed file already depends on, report it as a BREAKING CHANGE — even when the
code still compiles and even when the PR description calls it a cleanup or a
rename.**

A rename is not a cosmetic edit. Renaming a public thing is a *remove* plus an
*add*: every caller still asking for the old name gets nothing back. Compilation
proves the changed file is self-consistent; it proves nothing about callers that
were not updated in the same diff.

Treat all of these as public contract surface:

- a route path, method, or path/query parameter name
- a field in a **response** schema or payload
- an exported function, class, constant, or type signature
- an enum's member set
- an event / SSE message name

Report the finding as `BREAKING CHANGE: <what changed>`, name the old and new
form, and name who breaks. Say explicitly whether the break is at compile time
or silent at runtime — a silent break is the more serious of the two, because
nothing fails until a user notices missing data.

The only case that is NOT reportable: the same diff updates every consumer of
the thing it changed. If you cannot see the consumers in the diff, assume they
exist and report it.

## Bad — a rename presented as a cleanup

```ts
// PR title: "chore: tidy up response naming"
const PrSummary = z.object({
  id: z.string(),
-  reviewer_score: z.number(),
+  score: z.number(),
});
```

Every existing client reading `reviewer_score` now reads `undefined`. Nothing
throws. **Report it:** `BREAKING CHANGE: response field 'reviewer_score' renamed
to 'score'` — clients reading `reviewer_score` silently receive undefined at
runtime.

## Good — additive, so the old caller keeps working

```ts
const PrSummary = z.object({
  id: z.string(),
  reviewer_score: z.number(),
+  score: z.number(), // new alias; reviewer_score retained for existing clients
});
```

Both names resolve. Nothing to report.
