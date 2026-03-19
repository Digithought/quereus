description: AST visitor has inverted traversal logic and missing node type handlers
dependencies: none
files:
  packages/quereus/src/parser/visitor.ts
----
Two issues in `traverseAst`:

### 1. Inverted traversal control flow

The comment says "Functions can return false to stop traversal down that branch" but the code does the opposite:

```typescript
const result = callbacks.enterNode(node);
if (result !== false) return; // Stops when NOT false (including void/undefined)
```

A callback returning `void` (the natural default) causes traversal to STOP. Only returning `false` explicitly continues. This is backwards from the documented behavior and from visitor pattern conventions.

### 2. Missing node type handlers

The switch statement doesn't handle these Expression node types, causing a warning log and skipped traversal:
- `case` (CaseExpr) — should traverse baseExpr, whenThenClauses, elseExpr
- `in` (InExpr) — should traverse expr, values, subquery
- `exists` (ExistsExpr) — should traverse subquery
- `between` (BetweenExpr) — should traverse expr, lower, upper
- `mutatingSubquerySource` — should traverse stmt
- `analyze`, `declareSchema`, etc.

The WITH clause children (ctes) on select/insert/update/delete are also not traversed.

### Current impact
`traverseAst` is currently **unused** — it has zero external callers. This makes these defects latent. But the function is exported from the parser module and could be used by consumers.

### TODO
- Invert the traversal logic: return `false` should stop, return `void`/`true` should continue
- Add switch cases for `case`, `in`, `exists`, `between`, `mutatingSubquerySource`
- Add CTE/withClause traversal for select/insert/update/delete nodes
- Add basic test coverage for traverseAst
