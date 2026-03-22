description: MemoryTable.getIndexComparator now returns per-column comparators with DESC/collation support
dependencies: none
files:
  packages/quereus/src/vtab/table.ts              # VirtualTable interface — return type changed to CompareFn[]
  packages/quereus/src/vtab/capabilities.ts        # IsolationCapabilities interface — same
  packages/quereus/src/vtab/memory/table.ts        # Implementation — builds typed comparators per index column
  packages/quereus-isolation/src/isolated-table.ts # Consumer — buildCompareSortKey uses per-column comparators
  packages/quereus/test/capabilities.spec.ts       # Tests for ASC, DESC, NOCASE collation, composite indexes
----

## What was fixed

`MemoryTable.getIndexComparator()` returned a plain `compareSqlValues` comparator that ignored:
- DESC ordering (no sign inversion)
- Column collation (always binary)
- Composite indexes (single-value comparator, not per-column)

The isolation layer's `buildCompareSortKey` received the comparator but never used it (parameter was `_indexComparator`).

## What changed

**Interface**: `getIndexComparator` return type changed from `CompareFn | undefined` to `CompareFn[] | undefined` — an array of per-column comparators.

**Implementation** (`memory/table.ts`): Builds comparators using `resolveCollation` + `createTypedComparator` per index column, with DESC sign inversion. Mirrors the approach in `MemoryIndex.createIndexKeyFunctions()`.

**Consumer** (`isolated-table.ts`): `buildCompareSortKey` now uses the per-column comparators when iterating index key elements, falling back to `compareSqlValues` when none are provided.

## Test cases

- ASC index: standard ordering preserved
- DESC index: sign inversion verified (10 vs 20 reversed)
- NOCASE collation: 'Alice' == 'alice', case-insensitive ordering
- Composite index with mixed DESC: per-column direction verified independently
- Non-existent index: returns undefined
