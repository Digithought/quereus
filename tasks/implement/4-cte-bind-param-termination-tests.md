---
description: Add test coverage for recursive CTE with bind-parameter termination conditions
dependencies: Recursive CTE infrastructure, sqllogic test framework
---

## Context

Recursive CTEs can use bind parameters in termination conditions, e.g.:

```sql
WITH RECURSIVE tree(id) AS (
  SELECT id FROM Node WHERE id = ?1
  UNION ALL
  SELECT N.id FROM Node N JOIN tree T ON N.parent_id = T.id
  WHERE N.id != ?2
)
SELECT * FROM tree;
```

The current implementation handles this correctly — parameters are resolved to `ParameterReferenceNode` during planning, and the runtime evaluates them per-row in the filter predicate. The parameter value is constant across iterations, which is correct behavior.

However, there are **no explicit tests** for this pattern. This task adds test coverage to prevent regressions.

### Key files

| File | Role |
|------|------|
| `packages/quereus/test/logic/13-cte.sqllogic` | Basic CTE tests |
| `packages/quereus/test/logic/13.1-cte-multiple-recursive.sqllogic` | Multi-CTE tests |
| `packages/quereus/src/runtime/emit/recursive-cte.ts` | Recursive CTE execution |
| `packages/quereus/src/planner/building/with.ts` | CTE planning |

### Tests to add

Add a new test file `13.2-cte-bind-params.sqllogic` (or append to `13-cte.sqllogic`):

1. **Bind parameter in base case seed**: `WHERE id = ?` — already implicitly tested but should be explicit
2. **Bind parameter in recursive termination**: `WHERE depth < ?` — verify iteration stops at bound value
3. **Bind parameter as exclusion**: `WHERE id != ?` — verify specific nodes are excluded mid-walk
4. **Multiple bind parameters**: base case seed + recursive termination both parameterized
5. **Named parameters**: `:root_id`, `:max_depth` variants if supported

## TODO

- Create `13.2-cte-bind-params.sqllogic` test file with parameterized recursive CTE tests
- Verify all tests pass
- If any test reveals an issue, file a fix task
