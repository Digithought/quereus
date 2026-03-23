description: MemoryTable.getIndexComparator returns per-column comparators with DESC/collation support
files:
  packages/quereus/src/vtab/table.ts              # VirtualTable interface
  packages/quereus/src/vtab/capabilities.ts        # IsolationCapableTable interface
  packages/quereus/src/vtab/memory/table.ts        # Implementation
  packages/quereus-isolation/src/isolated-table.ts # Consumer (buildCompareSortKey)
  packages/quereus/test/capabilities.spec.ts       # Tests
----

## Summary

`getIndexComparator` return type changed from `CompareFn | undefined` to `CompareFn[] | undefined` — an array of per-column comparators that incorporate DESC ordering and collation. The isolation layer's `buildCompareSortKey` now consumes these comparators per-column, falling back to `compareSqlValues` when none are provided.

## Key files

- **Interface**: `VirtualTable.getIndexComparator` and `IsolationCapableTable.getIndexComparator` both return `CompareFn[] | undefined`
- **Implementation**: `MemoryTable.getIndexComparator` builds comparators via `resolveCollation` + `createTypedComparator`, with DESC sign inversion
- **Consumer**: `IsolatedTable.buildCompareSortKey` iterates per-column comparators for index key comparison

## Testing

14 tests in `capabilities.spec.ts` cover:
- ASC index: standard ordering preserved
- DESC index: sign inversion verified (10 vs 20 reversed)
- NOCASE collation: case-insensitive equality and ordering
- Composite index with mixed DESC: per-column direction independent
- Non-existent index: returns undefined

All isolation package tests (60/60) pass with no regressions.
