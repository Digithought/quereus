----
description: Extracted shared key serialization utility and fixed window partition/order-by collation bugs
----

## Summary

Generalized the bloom join's key serialization into a shared utility (`util/key-serializer.ts`) and fixed two bugs in window function partitioning and ranking where collation-unaware serialization was used.

## Changes

### New: `packages/quereus/src/util/key-serializer.ts`
Shared key serialization module with:
- `resolveKeyNormalizer(collationName)` — maps collation names (BINARY, NOCASE, RTRIM) to string normalizer functions
- `serializeKey(values, normalizers)` — type-tagged, collation-aware serialization returning null on any NULL value (for equi-join semantics)
- `serializeKeyNullGrouping(values, normalizers)` — same but treats NULL as a grouping sentinel (for PARTITION BY / DENSE_RANK semantics where NULLs group together)
- `serializeRowKey(row, indices, normalizers)` — row-indexed variant for bloom join

### Refactored: `runtime/emit/bloom-join.ts`
- Removed local `serializeKey` and `resolveKeyNormalizer`
- Now imports from `util/key-serializer.ts`
- Functionally identical behavior

### Fixed: `runtime/emit/window.ts`
- **Bug 1 fixed**: `groupByPartitions` used `JSON.stringify(partitionValues)` which was not collation-aware. Now uses `serializeKeyNullGrouping` with pre-resolved per-column collation normalizers. This means `PARTITION BY col COLLATE NOCASE` now correctly groups case-insensitively.
- **Bug 2 fixed**: `getOrderByKey` (used by DENSE_RANK) used `String(val).join('|')` with no type tags and no collation normalization. Now uses `serializeKeyNullGrouping` with pre-resolved order-by collation normalizers.
- Added `partitionKeyNormalizers` and `orderByKeyNormalizers` pre-resolved at emit time
- Threaded `orderByKeyNormalizers` through `processPartition` → `computeRankingFunction` → `getOrderByKey`

### Non-issue assessed: `core/database-transaction.ts`
`serializeKeyTuple` uses `JSON.stringify` for PK change tracking (exact-value equality, not SQL collated equality). Left as-is since it's correct for its purpose.

## Testing

### New tests in `test/logic/07.5-window.sqllogic`:
- NOCASE PARTITION BY with ROW_NUMBER and COUNT — verifies case-insensitive grouping
- NOCASE PARTITION BY with SUM — verifies aggregate correctness within collated partitions
- DENSE_RANK with NOCASE ORDER BY — verifies collation-aware key deduplication
- RANK with NOCASE ORDER BY — verifies collation-aware ranking
- NULL PARTITION BY — verifies NULLs group together (SQL standard)

### Existing tests:
- All 82-bloom-join.sqllogic tests pass (bloom join refactored, not changed)
- Full test suite passes (668+ quereus tests, 86 sync tests, all other packages)

## Validation
- `npx tsc --noEmit` passes
- `npm run build` succeeds
- `npm test` — all tests pass, zero failures
