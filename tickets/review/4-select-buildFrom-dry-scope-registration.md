description: Extract repeated scope registration pattern in buildFrom into a helper
dependencies: none
files:
  packages/quereus/src/planner/building/select.ts
----
## Summary

Extracted the repeated 6-line scope-registration-plus-aliasing pattern in `buildFrom` into a `registerColumnScope` helper function. Five call sites were replaced:

1. Internal recursive CTE reference
2. Regular CTE reference
3. View
4. Regular table
5. Function source

The subquery and mutating subquery cases were intentionally left inline — they have custom column names, bounds checking, type fallback, and conditional AliasedScope wrapping.

## Key interface

```ts
function registerColumnScope(
  parentScope: Scope,
  node: RelationalPlanNode,
  scopeName: string,
  alias: string,
): Scope
```

Located at `select.ts:254`, immediately above `buildFrom`.

## Testing

Pure refactoring — no behavioral change. All existing tests pass (`yarn build` + `yarn test`).

Key coverage areas:
- `packages/quereus/test/logic/*.sqllogic` — SQL logic tests covering FROM clauses with tables, views, CTEs, joins, table functions
- `packages/quereus/test/planner/` — planner-specific tests
- `packages/quereus/test/vtab/` — virtual table tests
