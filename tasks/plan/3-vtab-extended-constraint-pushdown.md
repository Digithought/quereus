---
description: Extend MemoryTable getBestAccessPlan to handle IS NULL, IS NOT NULL, and IN constraint operators
dependencies: none

---

# Extended Constraint Pushdown for MemoryTable

## Context

The modern `getBestAccessPlan` API in `MemoryTableModule` currently only recognizes equality (`=`) and range (`<`, `<=`, `>`, `>=`) operators when evaluating index access. The `ConstraintOp` type defined in `best-access-plan.ts` supports a richer set: `IS NULL`, `IS NOT NULL`, `IN`, `NOT IN`, `MATCH`, `LIKE`, `GLOB`.

## Expected Behavior

- **IS NULL / IS NOT NULL**: For nullable indexed columns, these constraints should be exploitable. `IS NULL` on a PK column means the result is empty (PKs are NOT NULL by default). `IS NOT NULL` on a non-nullable column is trivially true and can be omitted.
- **IN**: An `IN (v1, v2, ...)` constraint on an index column could be handled as multiple point lookups, potentially cheaper than a full scan when the value set is small relative to table size.

## Use Case

Queries like `SELECT * FROM t WHERE id IN (1, 2, 3)` or `SELECT * FROM t WHERE nullable_col IS NULL` should benefit from index-aware planning rather than falling back to a full scan with residual filter.

## Key Files

- `packages/quereus/src/vtab/memory/module.ts` - `findEqualityMatches`, `findRangeMatch`, `evaluateIndexAccess`
- `packages/quereus/src/vtab/best-access-plan.ts` - `ConstraintOp` type, `PredicateConstraint`
- `packages/quereus/src/vtab/memory/layer/scan-plan.ts` - `ScanPlan`, `buildScanPlanFromFilterInfo`
- Runtime cursor code that evaluates scan plans against the BTree
