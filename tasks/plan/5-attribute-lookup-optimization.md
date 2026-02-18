---
description: Optimize resolveAttribute from O(n) linear scan to O(1) direct lookup
dependencies: Runtime context infrastructure
---

## Problem

`resolveAttribute()` in `src/runtime/context-helpers.ts` is called on every column reference evaluation — the hottest path in query execution. Currently it:

1. Creates a new array from the context Map entries: `Array.from(rctx.context.entries())`
2. Reverses the array: `.reverse()`
3. Iterates linearly to find the matching attribute ID

This is O(n) per column reference where n = number of active row descriptors in scope. For queries with joins or subqueries, n grows and this becomes a significant overhead since it's invoked per-row per-column.

## Expected Behavior

Column reference resolution should be O(1) — a direct lookup from attribute ID to its value, with no per-call allocation.

## Approach

Maintain a secondary index `Map<attributeId, { descriptor, columnIndex }>` on RuntimeContext that is updated when descriptors are added/removed. The `resolveAttribute` function then becomes a single Map.get() call.

Alternatively, since attribute IDs are dense integers assigned at plan time, a flat array indexed by attribute ID could be even faster than a Map.

Something to move this to plan time only?

## Key Files

- `packages/quereus/src/runtime/context-helpers.ts` — `resolveAttribute()`, `createRowSlot()`, `withRowContext()`, etc.
- `packages/quereus/src/runtime/types.ts` — `RuntimeContext` type definition
- `packages/quereus/src/runtime/emit/column-reference.ts` — primary caller

