description: Fixed AST visitor inverted traversal logic and added missing node type handlers
dependencies: none
files:
  packages/quereus/src/parser/visitor.ts
  packages/quereus/test/visitor.spec.ts
----
### What was fixed

**1. Inverted traversal control flow**

`enterNode` and specific visitor callbacks used `result !== false` to stop, which inverted the logic:
returning `void` (the default) stopped traversal, while returning `false` continued it. Fixed to
`result === false` so that returning `false` stops the branch and `void`/`true` continues — matching
the documented behavior and visitor pattern conventions.

**2. Missing expression node type handlers**

Added switch cases for:
- `case` (CaseExpr) — traverses baseExpr, whenThenClauses (when + then), elseExpr
- `in` (InExpr) — traverses expr, values list, subquery
- `exists` (ExistsExpr) — traverses subquery
- `between` (BetweenExpr) — traverses expr, lower, upper
- `mutatingSubquerySource` — traverses stmt

Added `analyze` and `declareSchema` to the DDL no-op list to suppress the unhandled-type warning.

**3. CTE/withClause traversal**

Added `withClause?.ctes` traversal to `select`, `insert`, `update`, and `delete` cases so CTE
subqueries are visited.

### Testing

14 new tests in `test/visitor.spec.ts`:
- Traversal continues with void/true return, stops with false
- enterNode false prevents exitNode call
- Specific visitor false stops branch traversal
- exitNode called after children
- CASE, IN, EXISTS, BETWEEN expression traversal
- CTE traversal in SELECT with WITH clause
- Graceful handling of undefined nodes
