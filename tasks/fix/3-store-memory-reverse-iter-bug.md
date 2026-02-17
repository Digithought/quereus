---
description: Fix InMemoryKVStore.iterate() reverse iteration with bounds returning empty results
dependencies: packages/quereus-store/src/common/memory-store.ts
priority: 3
---

# InMemoryKVStore Reverse Iteration with Bounds Bug

## Problem

`InMemoryKVStore.iterate()` returns zero results when called with `reverse: true` and bounds (e.g., `gte`/`lte`). This is because the upper-bound `break` logic fires on the first entry in the reversed iteration order, which is the highest key.

## Location

`packages/quereus-store/src/common/memory-store.ts`, lines 82–96.

When `reverse: true`, the `entries` array is reversed (line 77), so iteration starts at the highest key. But the bound checks on lines 84–89 are written for forward iteration:

```typescript
// Check lower bounds (skip entries below lower bound)
if (gteHex !== undefined && keyHex < gteHex) continue;
if (gtHex !== undefined && keyHex <= gtHex) continue;

// Check upper bounds (stop when past upper bound)
if (lteHex !== undefined && keyHex > lteHex) break;
if (ltHex !== undefined && keyHex >= ltHex) break;
```

In forward iteration, `break` is correct for upper bounds because all subsequent entries will also exceed the bound. In reverse iteration, the first entry has the *highest* key, so the upper-bound `break` fires immediately and terminates the loop with zero results.

## Fix

For reverse iteration, swap the semantics: upper bounds should `continue` (skip entries above the range) and lower bounds should `break` (stop once past the lower end). Example:

```typescript
if (reverse) {
  // Reverse: descending order, skip entries above upper bound, stop below lower bound
  if (lteHex !== undefined && keyHex > lteHex) continue;
  if (ltHex !== undefined && keyHex >= ltHex) continue;
  if (gteHex !== undefined && keyHex < gteHex) break;
  if (gtHex !== undefined && keyHex <= gtHex) break;
} else {
  // Forward: ascending order, skip entries below lower bound, stop above upper bound
  if (gteHex !== undefined && keyHex < gteHex) continue;
  if (gtHex !== undefined && keyHex <= gtHex) continue;
  if (lteHex !== undefined && keyHex > lteHex) break;
  if (ltHex !== undefined && keyHex >= ltHex) break;
}
```

## Test

Failing test already exists (currently `.skip`):
`packages/quereus-store/test/memory-store.spec.ts` → `'supports reverse with bounds'`

## TODO

- [ ] Fix bound-check logic in `iterate()` for reverse iteration
- [ ] Un-skip the test and verify it passes

