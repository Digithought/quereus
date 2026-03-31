description: SortCapable interface now preserves nulls ordering
dependencies: none
files:
  packages/quereus/src/planner/nodes/sort.ts
  packages/quereus/src/planner/framework/characteristics.ts
----
## Summary

The `SortCapable` interface sort key type now includes an optional `nulls?: 'first' | 'last'` field, matching the internal `SortKey` type. `SortNode.getSortKeys()` passes through the `nulls` field, and `SortNode.withSortKeys()` preserves it from input keys instead of discarding it.

## Changes

**`characteristics.ts`** — Added `nulls?: 'first' | 'last'` to both `getSortKeys()` return type and `withSortKeys()` parameter type in the `SortCapable` interface.

**`sort.ts`** — Updated `getSortKeys()` to include `nulls` in the returned objects. Updated `withSortKeys()` to preserve `nulls` from input keys (instead of setting `undefined`), use the `SortKey` type directly, and include `nulls` in the change-detection check.

## Callers audited

- `rule-grow-retrieve.ts:288` — Calls `getSortKeys()` and passes result to `extractOrderingFromSortKeys()`, which only uses `expression` and `direction`. No change needed; the extra `nulls` field is structurally compatible.
- No callers of `withSortKeys()` were found outside `SortNode` itself.

## Testing

- Build passes
- All 1013 tests pass
- The fix is type-safe: existing code that doesn't use `nulls` is unaffected since the field is optional

## Validation notes

- Verify that `getSortKeys().nulls` round-trips correctly through `withSortKeys()` for keys with explicit NULLS FIRST/NULLS LAST
- Verify that optimizer rules rewriting sort keys through `SortCapable` preserve null ordering
