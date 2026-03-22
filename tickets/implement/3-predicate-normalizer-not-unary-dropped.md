description: Fix pushNotDown dropping NOT wrapper on non-NOT unary ops (e.g. NOT(-x) → -x)
dependencies: none
files:
  packages/quereus/src/planner/analysis/predicate-normalizer.ts
  packages/quereus/test/optimizer/predicate-analysis.spec.ts
----
## Problem

In `predicate-normalizer.ts`, `pushNotDown()` handles a UnaryOp that is not itself a NOT
operator by normalizing the operand and returning the rebuilt inner node — but forgets to re-wrap
it in NOT. Both branches of the ternary were identical (copy-paste bug), and neither wrapped in NOT.

`NOT(MINUS(x))` was incorrectly returning `MINUS(normalize(x))`, silently dropping the negation.

## Root Cause

Line 87 (original): both ternary branches produced `new UnaryOpNode(u.scope, u.expression, nOp)`,
which rebuilds the inner unary (e.g. MINUS) without wrapping it in NOT.

## Fix Applied

Rebuild the inner unary node only when operand changed, then wrap in a NOT UnaryOpNode:

```ts
const nOp = normalize(u.operand);
const inner = nOp === u.operand ? u : new UnaryOpNode(u.scope, u.expression, nOp);
const notAst: AST.UnaryExpr = { type: 'unary', operator: 'NOT', expr: u.expression };
return new UnaryOpNode(u.scope, notAst, inner);
```

## Tests Added

- `NOT(-col)` normalizes to `NOT(-col)` (NOT preserved around unary minus)
- `NOT(NOT(-col))` normalizes to `-col` (double negation elimination + existing NOT elimination)

## TODO

- [x] Fix the NOT-dropping bug in pushNotDown
- [x] Add test: `NOT(-col)` normalizes to `NOT(-col)` not `-col`
- [x] Add test: `NOT(NOT(-col))` normalizes to `-col`
- [x] All predicate analysis tests pass (11/11)
- [x] Full test suite passes (pre-existing unrelated failure in emit-missing-types.spec.ts)
