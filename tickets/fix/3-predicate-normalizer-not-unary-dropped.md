description: pushNotDown drops NOT wrapper when applied to non-NOT unary ops (e.g. NOT(-x) → -x)
dependencies: none
files:
  packages/quereus/src/planner/analysis/predicate-normalizer.ts
  packages/quereus/test/optimizer/predicate-analysis.spec.ts
----
## Problem

In `predicate-normalizer.ts:85-87`, `pushNotDown()` handles a UnaryOp that is NOT itself a NOT
operator by normalizing the operand and returning the rebuilt inner node — but forgets to re-wrap
it in NOT.

```ts
// Line 87 — both branches are identical, and neither wraps in NOT
return nOp === u.operand
    ? new UnaryOpNode(u.scope, u.expression, nOp)   // returns MINUS(nOp) — NOT is lost
    : new UnaryOpNode(u.scope, u.expression, nOp);   // same thing
```

`pushNotDown(node)` is called when we encounter `NOT(node)` and should return the simplified
equivalent. For `NOT(MINUS(x))`, the correct result is `NOT(MINUS(normalize(x)))` since there's
no algebraic simplification. The current code returns `MINUS(normalize(x))`, silently dropping
the negation.

### Impact

Low in practice — `NOT(-x)`, `NOT(+x)`, `NOT(~x)` are unusual SQL patterns. However, this is a
correctness defect in the normalizer.

### Secondary issue

The ternary is redundant — both branches produce the identical expression, indicating copy-paste.

## Fix

Rebuild the inner unary node only when the operand changed, then wrap it in a NOT UnaryOpNode:

```ts
const nOp = normalize(u.operand);
const inner = nOp === u.operand ? u : new UnaryOpNode(u.scope, u.expression, nOp);
const notAst: AST.UnaryExpr = { type: 'unary', operator: 'NOT', expr: u.expression };
return new UnaryOpNode(u.scope, notAst, inner);
```

## TODO

- Fix the NOT-dropping bug in pushNotDown
- Add test: `NOT(-col)` normalizes to `NOT(-col)` not `-col`
- Add test: `NOT(NOT(-col))` normalizes to `-col` (double negation + existing NOT elimination)
