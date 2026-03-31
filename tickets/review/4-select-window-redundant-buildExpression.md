description: Eliminate redundant buildExpression calls in window function projection building
dependencies: none
files:
  packages/quereus/src/planner/building/select-window.ts
----
## Summary

Eliminated redundant `buildExpression` calls in `buildWindowProjections` and `findWindowFunctionIndex`.
Previously, each column in a SELECT with window functions triggered 2-3 `buildExpression` calls
(one for classification, one for projection, one inside `findWindowFunctionIndex`). Now each
column's expression is built once and reused.

### Changes

- `buildWindowProjections`: Builds `builtExpr` once per column, reuses it for `isWindowExpression`
  check and as the projection node for non-window columns.
- `findWindowFunctionIndex`: Signature changed to accept a pre-built `ScalarPlanNode` instead of
  an `AST.ResultColumnExpr` + `PlanningContext`, eliminating its internal `buildExpression` call.

## Testing / Validation

- All 1013 existing tests pass (includes window function tests in sqllogic suite).
- No lint issues in the changed file.
- Key test scenarios to verify:
  - SELECT with mixed window and non-window columns
  - Multiple window functions with different PARTITION BY / ORDER BY
  - Expressions wrapping window functions (e.g., `row_number() + 1`)
  - COUNT(*) OVER (...) — special-case argument handling
