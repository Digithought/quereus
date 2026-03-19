description: MemoryTable.getIndexComparator ignores DESC and collation settings
dependencies: none
files:
  packages/quereus/src/vtab/memory/table.ts
  packages/quereus-isolation/src/isolated-table.ts
----
`MemoryTable.getIndexComparator()` (table.ts:411-419) returns a plain `compareSqlValues` comparator
that ignores the index's column definitions:

- DESC ordering is not applied (no sign inversion)
- Column collation is not respected (always uses default binary comparison)
- For composite indexes, the comparator only compares single values, not tuples

This comparator is used by the isolation layer (`isolated-table.ts:483`) for merging overlay
and underlying index scans. If a DESC index or a collation-specific index is used, the merge
could produce incorrect ordering.

The fix should mirror the approach used in `MemoryIndex.createIndexKeyFunctions()` which correctly
handles DESC multipliers and type-aware/collation-aware comparators.

## TODO
- Update `getIndexComparator` to build a comparator from the index's `IndexSchema.columns`
- Handle DESC columns (sign inversion)
- Apply `resolveCollation` / `createTypedComparator` per column
- Handle composite indexes (tuple comparison)
- Add test cases for DESC and collation-specific indexes
