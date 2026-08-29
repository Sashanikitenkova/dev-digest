---
name: response-schema
description: Treat response-shape edits as wire-visible; a field dropped from a response schema is stripped even if the handler still returns it.
type: convention
---

# response-schema

**Rule: any edit to a response schema changes the wire format. Check the schema,
not the handler — with `fastify-type-provider-zod` the response schema is a
filter, so a field missing from the schema is stripped from the response even
when the handler still returns it.**

This is the failure mode that hides best in review: the handler code still says
`return { score, cost }`, so the diff *looks* like it still sends `cost`. It
does not. Fastify serializes through the response schema and drops anything the
schema does not declare.

Check three things on every response-schema edit:

1. **Removed or renamed field** → breaking for every reader of that field.
2. **Required-ness tightened** (`.optional()`/`.nullish()` removed) → a
   payload that legitimately omitted the field now fails serialization.
3. **Type narrowed** (`string` → enum, number bounds added) → previously valid
   values now error.

Widening is safe: a new optional field, or a loosened type, breaks nobody.

Note the asymmetry between `.nullable()` and `.nullish()`: `.nullable()` still
requires the KEY to be present, so a code path that omits the key entirely
breaks. A field some routes cannot populate must be `.nullish()`.

## Bad — the handler lies about the wire

```ts
const PrDetail = z.object({
  id: z.string(),
-  cost_usd: z.number().nullish(),
});

// unchanged, and misleading:
return { id: pr.id, cost_usd: pr.costUsd };
```

`cost_usd` is silently stripped from every response. **Report it.**

## Good — deprecate on the wire before removing

```ts
const PrDetail = z.object({
  id: z.string(),
  /** @deprecated use `cost` — removal scheduled for v3 */
  cost_usd: z.number().nullish(),
  cost: z.number().nullish(),
});
```
