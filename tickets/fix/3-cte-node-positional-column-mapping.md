description: CTENode.buildAttributes() uses name-based lookup instead of positional mapping for explicit column names
dependencies: none
files:
  packages/quereus/src/planner/nodes/cte-node.ts
----
## Defect

When a non-recursive CTE provides explicit column names that differ from the source query's column names (e.g., `WITH cte(x, y) AS (SELECT a, b FROM t)`), `CTENode.buildAttributes()` tries to match by name rather than by position. Since the explicit names don't match the source names, the lookup fails and all columns fall back to `TEXT` type.

The sibling `RecursiveCTENode.buildAttributes()` correctly uses positional mapping (`baseCaseAttributes.map((attr, index) => ...)`).

## Impact

Downstream type inference will be wrong for any non-recursive CTE that renames columns. Runtime behavior is correct (SQL is dynamically typed) but optimizer decisions based on types could be suboptimal or incorrect.

## Fix

Change `buildAttributes()` to use positional indexing instead of name-based lookup. Also clean up the 4 `any` casts (lines 64, 69, 72, 95) since the `RelationType.columns` type already provides proper typing.

## TODO

- Replace name-based attribute lookup with positional mapping in `CTENode.buildAttributes()`
- Remove `any` casts and eslint-disable comments
- Add a sqllogic test: `WITH cte(x, y) AS (SELECT 1 AS a, 'hello' AS b) SELECT typeof(x), typeof(y) FROM cte` expecting integer and text
