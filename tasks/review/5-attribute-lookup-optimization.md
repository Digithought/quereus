---
description: Optimized resolveAttribute from O(n) linear scan to O(1) direct lookup via RowContextMap attribute index
dependencies: None
---

## Summary

`resolveAttribute()` — the hottest path in query execution (called per column reference per row) — was optimized from O(n) linear scan with per-call allocation to O(1) array-indexed lookup with zero allocation on the hot path.

## What Changed

### New: `RowContextMap` class (`packages/quereus/src/runtime/context-helpers.ts`)

Replaces the raw `Map<RowDescriptor, RowGetter>` on `RuntimeContext.context`. Wraps a Map with an automatically-maintained secondary index: `attributeIndex: Array<IndexEntry | undefined>`, where `IndexEntry = { rowGetter: RowGetter; columnIndex: number }`.

- **`set(descriptor, rowGetter)`** — updates the Map and indexes all attribute IDs in the descriptor
- **`delete(descriptor)`** — removes from Map, clears affected index entries, then rebuilds them from remaining Map entries (last/newest wins)
- **`get(descriptor)`**, **`entries()`**, **`size`** — delegate to the underlying Map

A `descriptorEntries()` generator handles both proper arrays and plain-object descriptors (created by `{...array}` spread in aggregate.ts).

### Modified: `resolveAttribute()` (`packages/quereus/src/runtime/context-helpers.ts`)

1. **Fast path**: Single array index lookup via `rctx.context.attributeIndex[attributeId]`
2. **Fallback**: Linear scan (same as original) for edge cases where a slot is indexed but its row isn't populated yet (e.g., `createRowSlot` installs context before first `slot.set(row)`)
3. **Error path**: Unchanged

### Modified: `RuntimeContext.context` type (`packages/quereus/src/runtime/types.ts`)

Changed from `Map<RowDescriptor, RowGetter>` to `RowContextMap`.

### Modified: 5 RuntimeContext construction sites

All changed from `context: new Map()` to `context: new RowContextMap()`:
- `packages/quereus/src/core/statement.ts`
- `packages/quereus/src/core/database.ts`
- `packages/quereus/src/core/database-assertions.ts`
- `packages/quereus/src/planner/analysis/const-evaluator.ts`
- `packages/quereus/src/runtime/deferred-constraint-queue.ts`

## Design Decisions

1. **RowContextMap class vs standalone helpers**: Encapsulating the index inside RowContextMap ensures all callers (including aggregate.ts which directly calls `ctx.context.set()`/`delete()`) get correct index maintenance automatically, without requiring changes to every caller.

2. **Fallback linear scan**: Kept for correctness when slots are indexed before their first row is set. This handles the project.ts pattern where output slot and source slot are created (indexed), but source slot's row isn't set until iteration begins.

3. **`descriptorEntries` with `for...in`**: RowDescriptors are `number[]` (sparse arrays), but aggregate.ts creates combined descriptors via `{...array}` which produces plain objects without `.length`. Using `for...in` handles both forms correctly.

4. **Delete-rebuild strategy**: On delete, affected index entries are cleared then rebuilt by iterating ALL remaining Map entries. No early termination — last entry wins, matching Map insertion-order semantics where newest overwrites oldest.

## Testing & Validation

All existing tests pass unchanged (1217+ tests across all suites). This is a pure performance optimization with identical semantics — no new tests were needed. Key test categories that exercise this path:

- **Recursive CTEs** — multiple overlapping context scopes with fresh attribute IDs per CTE reference
- **Aggregate GROUP BY** — direct context manipulation with spread-created descriptors
- **JOINs** — left/right row slots with concurrent attribute bindings
- **Subqueries** — nested context scopes with sort/project slot lifecycle
- **Mutation context** — constraint checks with `createRowSlot` before row population
- **Window functions** — complex context layering

## Usage

No API changes. All callers continue to use `rctx.context.set()`, `rctx.context.delete()`, `createRowSlot()`, `withRowContext()`, and `withAsyncRowContext()` exactly as before. The optimization is fully transparent.

Code that creates `RuntimeContext` objects must use `new RowContextMap()` instead of `new Map()` for the `context` field.
