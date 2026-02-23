---
description: Support HAVING with COUNT(DISTINCT ...) and other DISTINCT aggregates
---

## Summary

Added support for `HAVING` clauses containing aggregate functions with the `DISTINCT` modifier (e.g., `HAVING COUNT(DISTINCT col) > 1`). Previously, `COUNT(DISTINCT ...)` worked in `SELECT` expressions and `HAVING` worked with non-distinct aggregates, but combining them was not supported.

## Changes

### 1. Fixed DISTINCT comparison in aggregate matching (`function-call.ts`)

The aggregate matching logic in `buildFunctionCall` (used when resolving HAVING aggregates against SELECT aggregates) now compares the `isDistinct` flag. Previously, `COUNT(DISTINCT val)` in HAVING would incorrectly match `COUNT(val)` in SELECT because only function name and argument count/values were compared.

### 2. Pre-collect HAVING aggregates (`select-aggregates.ts`)

Added `findAggregateFunctionExprs()` and `collectHavingAggregates()` functions that walk the HAVING AST expression tree to discover aggregate function calls not already present in the SELECT list. These are added to the `AggregateNode` so they are computed during aggregation and available for the HAVING filter.

A final `ProjectNode` is forced when HAVING-only aggregates are added, to strip them from the query output (they exist only for the filter, not for the result set).

### 3. Output column stripping (`select.ts`)

When HAVING-only aggregates are present, the final `ProjectNode` uses `preserveInputColumns = false` to prevent the HAVING-only aggregate columns from leaking into the query output.

## Testing

Five new test cases added to `07-aggregates.sqllogic`:

- `HAVING COUNT(DISTINCT col) > n` where aggregate is only in HAVING (not SELECT)
- `HAVING COUNT(DISTINCT col) > n` where aggregate is in both SELECT and HAVING
- `HAVING SUM(DISTINCT val) > n` (non-COUNT distinct aggregate)
- SELECT has `COUNT(val)`, HAVING has `COUNT(DISTINCT val)` (must be different aggregates)
- `HAVING COUNT(DISTINCT a) + COUNT(DISTINCT b) > n` (multiple distinct aggregates in expression)

All 672 tests pass.

## Validation

```sql
-- Filter groups by distinct count
SELECT grp FROM t GROUP BY grp HAVING COUNT(DISTINCT val) > 1;

-- With other distinct aggregates
SELECT grp FROM t GROUP BY grp HAVING SUM(DISTINCT val) > 100;

-- Nested in expressions
SELECT grp FROM t GROUP BY grp HAVING COUNT(DISTINCT val) + COUNT(DISTINCT other) > 3;

-- Mixed: SELECT non-distinct, HAVING distinct (correctly treated as separate aggregates)
SELECT grp, COUNT(val) as cv FROM t GROUP BY grp HAVING COUNT(DISTINCT val) = 1;
```
