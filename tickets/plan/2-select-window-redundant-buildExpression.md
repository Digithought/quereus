description: Eliminate redundant buildExpression calls in window function projection building
dependencies: none
files:
  packages/quereus/src/planner/building/select-window.ts
----
## Finding: Redundant expression building in window projections

**Severity**: smell / performance

In `buildWindowProjections` (line ~170), `buildExpression` is called to check `isWindowExpression`, and then called again at line ~195 for non-window columns. Additionally, `findWindowFunctionIndex` calls `buildExpression` a third time for window columns.

Each `buildExpression` call creates new plan nodes and traverses the AST. For complex SELECT lists with many columns or deep expressions, this triples the work.

**Suggested fix**: Build expressions once upfront, then classify and index from the cached results:

```ts
const builtColumns = stmt.columns
  .filter(c => c.type === 'column')
  .map(c => ({
    column: c,
    expr: buildExpression(selectContext, c.expr, true),
  }));
```

Then use `builtColumns[i].expr` for both window detection and projection creation.
