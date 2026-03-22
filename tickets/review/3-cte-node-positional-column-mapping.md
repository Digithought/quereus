description: Fix CTENode.buildAttributes() to use positional mapping instead of name-based lookup for explicit CTE column names
dependencies: none
files:
  packages/quereus/src/planner/nodes/cte-node.ts
  packages/quereus/test/logic/13-cte.sqllogic
----
## Summary

`CTENode.buildAttributes()` was using name-based lookup to resolve column types when explicit CTE column names were provided (e.g., `WITH cte(x, y) AS (SELECT a, b FROM t)`). Since the explicit names (`x`, `y`) don't match the source names (`a`, `b`), the lookup always failed and all columns fell back to `TEXT` type.

Fixed by switching to positional mapping (matching the sibling `RecursiveCTENode.buildAttributes()` pattern), and removed 4 `any` casts plus their `eslint-disable` comments.

## Changes

- `buildAttributes()`: replaced name-based `find()` with positional `map((attr, index) => ...)` over source attributes
- Removed `ScalarType` import and `TEXT_TYPE` import (no longer needed — no fallback path)
- Removed all `any` casts and `eslint-disable` comments from `buildAttributes()` and `buildType()`

## Testing

- Added sqllogic test in `13-cte.sqllogic`: `WITH cte(x, y) AS (SELECT 1 AS a, 'hello' AS b) SELECT typeof(x), typeof(y) FROM cte` — verifies runtime types are correct with renamed columns
- All 928 existing tests pass
- Build and lint clean on changed file

## Use cases for validation

- `WITH cte(x) AS (SELECT id FROM t) SELECT x FROM cte` — renamed column should carry the source type (INTEGER), not TEXT
- `WITH cte(a) AS (SELECT a FROM t) SELECT a FROM cte` — same-name case should still work (no regression)
- Recursive CTEs with explicit column names (already tested, uses separate `RecursiveCTENode`)
