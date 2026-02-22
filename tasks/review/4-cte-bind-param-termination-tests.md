---
description: Review test coverage for recursive CTE with bind-parameter termination conditions
dependencies: none
---

## Summary

Added test coverage for recursive CTEs with bind parameters in termination conditions. Two changes were made:

### 1. `-- params:` directive in sqllogic test runner

**File:** `packages/quereus/test/logic.spec.ts`

Added a new `-- params: <JSON>` comment directive that supplies bind parameter values for the next query in `.sqllogic` test files. The JSON array is parsed and passed through `executeWithTracing` → `stmt.bindAll()`. Parameters are reset after each query execution.

### 2. Test file: `13.2-cte-bind-params.sqllogic`

**8 test cases** covering:

| # | Pattern | Description |
|---|---------|-------------|
| 1 | Seed `WHERE id = ?` | Bind parameter in base case, full tree from root |
| 2 | Seed `WHERE id = ?` (subtree) | Different seed value, subtree traversal |
| 3 | Termination `WHERE depth < ?` | Parameterized depth limit stops recursion |
| 4 | Exclusion `WHERE id != ?` | Parameterized node exclusion mid-walk |
| 5 | Multiple params (seed + termination) | `?` in base case and `?` in recursive filter |
| 6 | Multiple params (seed + exclusion) | `?` for root selection and `?` for exclusion |
| 7 | Counting CTE with param limit | `WHERE n < ?` parameterized upper bound |
| 8 | Counting CTE with param start + limit | Both seed value and upper bound parameterized |

### Validation

- All 8 new tests pass
- Full test suite: 668 passing, 7 pending (pre-existing skips), 0 failures
- No issues discovered; bind parameters resolve correctly through `ParameterReferenceNode` in recursive CTE evaluation

### Key files

| File | Change |
|------|--------|
| `packages/quereus/test/logic.spec.ts` | Added `-- params:` directive parsing |
| `packages/quereus/test/logic/13.2-cte-bind-params.sqllogic` | New test file |

## TODO

- Verify the `-- params:` directive works correctly with the test runner
- Verify all 8 test cases exercise distinct code paths
- Confirm no regressions in existing tests
- Check that the params directive is properly reset between queries
