---
description: Pre-resolved comparators to eliminate runtime overhead in hot paths
dependencies: Logical type system, Memory VTable, Sort/Join nodes
---

## Summary

Eliminated runtime overhead in comparison hot paths by pre-resolving comparators at emit time (plan compilation). Two strategies were applied based on type safety guarantees:

### Strategy 1: Typed Comparators (guaranteed same-type values)
Used `createTypedComparator()` which leverages `LogicalType.compare()` to skip `getStorageClass()` detection entirely.

**Applied to:**
- **Aggregate GROUP BY keys** (`aggregate.ts`): Pre-resolved per-expression comparators from `plan.groupBy[i].getType()`. Eliminates `compareSqlValues()` calls in `compareGroupKeys()`.
- **Aggregate DISTINCT tracking** (`aggregate.ts`): Pre-resolved per-argument typed comparators for each aggregate function, replacing generic `compareDistinctValues()`.
- **Window ORDER BY equality** (`window.ts`): Pre-resolved typed equality comparators for ranking functions (`rank`, `dense_rank`), replacing `compareSqlValues()` in `areRowsEqualInOrderBy()`.

### Strategy 2: Collation-Only Pre-Resolution (mixed-type values possible)
Used `createCollationRowComparator()` which pre-resolves collation functions but still uses `compareSqlValuesFast()` for safe cross-type comparison.

**Applied to:**
- **DISTINCT** (`distinct.ts`): Replaced `compareRows()` with collation-aware row comparator.
- **SET OPERATIONS** (`set-operation.ts`): Replaced `compareRows()` in all BTree-based operations (UNION, INTERSECT, EXCEPT).
- **JOIN USING** (`join.ts`): Pre-resolved column indices and collation functions, eliminating `findIndex()` per-row and `compareSqlValues()` collation lookup.

### Strategy 3: Fixed Hardcoded Collation
- **Window ORDER BY sort** (`window.ts`): Fixed hardcoded `'BINARY'` collation in `sortRows()` to extract actual collation from `plan.orderByExpressions[i].getType().collationName`.

## New Utilities

- `createTypedRowComparator(types, collations)` in `comparison.ts`: Row comparator with per-column typed comparators. For use when runtime types are guaranteed.
- `createCollationRowComparator(collations)` in `comparison.ts`: Row comparator with pre-resolved collations, safe for mixed-type rows.

## Files Changed

- `packages/quereus/src/util/comparison.ts` — New utilities
- `packages/quereus/src/runtime/emit/join.ts` — USING pre-resolution
- `packages/quereus/src/runtime/emit/distinct.ts` — Collation row comparator
- `packages/quereus/src/runtime/emit/aggregate.ts` — Typed GROUP BY + DISTINCT comparators
- `packages/quereus/src/runtime/emit/set-operation.ts` — Collation row comparator
- `packages/quereus/src/runtime/emit/window.ts` — Fixed collation + typed equality

## Testing

- All 54 SQL logic tests pass (including set operations, aggregates, windows, joins, distinct)
- All 36 memory vtable tests pass
- All 12 performance sentinel tests pass
- TypeScript build clean (no new errors)
