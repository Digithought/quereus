description: Fix pushNotDown dropping NOT wrapper on non-NOT unary ops (e.g. NOT(-x) → -x)
dependencies: none
files:
  packages/quereus/src/planner/analysis/predicate-normalizer.ts
  packages/quereus/test/optimizer/predicate-analysis.spec.ts
----
## Summary

Fixed a copy-paste bug in `pushNotDown()` where `NOT(unary_op(x))` for non-NOT unary operators
(e.g. unary minus `-`) silently dropped the NOT wrapper, returning just `unary_op(normalize(x))`.

The fix rebuilds the inner unary node (only when operand changed), then wraps it in a NOT
UnaryOpNode, at lines 85-89 of `predicate-normalizer.ts`.

## Test Cases

- `NOT(-col)` normalizes to `NOT(-col)` — NOT is preserved around unary minus
- `NOT(NOT(-col))` normalizes to `-col` — double negation elimination works with inner unary ops

## Validation

- All 11 predicate analysis tests pass
- Build passes
