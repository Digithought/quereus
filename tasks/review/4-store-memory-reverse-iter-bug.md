---
description: Fix InMemoryKVStore.iterate() reverse iteration with bounds returning empty results
files: packages/quereus-store/src/common/memory-store.ts, packages/quereus-store/test/memory-store.spec.ts
---

# InMemoryKVStore Reverse Iteration Bug — Fix Summary

## Problem
`InMemoryKVStore.iterate()` returned zero results when called with `reverse: true` and bounds (e.g., `gte`/`lte`). The upper-bound `break` logic fired immediately on the first entry in reversed order (the highest key), terminating the loop before yielding any results.

## Fix
Added a `reverse` branch in the bound-check logic within `iterate()`:
- **Forward (ascending):** lower bounds `continue`, upper bounds `break` — unchanged.
- **Reverse (descending):** upper bounds `continue` (skip entries above range), lower bounds `break` (stop once past lower end).

## Testing
- Un-skipped the existing `'supports reverse with bounds'` test in `memory-store.spec.ts`.
- All 134 tests in `@quereus/store` pass.

## Validation
- `yarn workspace @quereus/store test` — 134 passing.
