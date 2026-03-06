description: Expression fingerprinting infrastructure for common subexpression detection
files:
  - packages/quereus/src/planner/analysis/expression-fingerprint.ts (new)
  - packages/quereus/test/optimizer/expression-fingerprint.spec.ts (new)
----

## Summary

Implemented `fingerprintExpression(node: ScalarPlanNode): string` that produces a canonical string identifying the computation performed by a scalar expression tree. Two subtrees with the same fingerprint compute the same value given the same row input.

### Key decisions

- **Format**: Short prefixed tags — `LI:` (literal), `CR:` (column ref), `PR:` (param ref), `UO:` (unary op), `BO:` (binary op), `FN:` (scalar function), `AG:` (aggregate), `CE` (case), `CA:` (cast), `CO:` (collate), `BW:` (between), `AI:` (array index), `WF:` (window function)
- **Determinism guard**: Non-deterministic nodes (e.g., `random()`) return `_ND:<nodeId>` so they never match
- **Commutativity**: For `+`, `*`, `=`, `!=`, `<>`, `AND`, `OR`, child fingerprints are sorted lexicographically so `a + b` and `b + a` produce the same fingerprint
- **Subquery nodes**: `ScalarSubquery`, `In`, `Exists` get unique `_SQ:<nodeId>` fingerprints since canonicalizing entire relational subplans is out of scope
- **Aggregate vs scalar function**: Both share `PlanNodeType.ScalarFunctionCall`; distinguished by checking for the `functionName` property on `AggregateFunctionCallNode`
- **Literal type tagging**: `5n` (bigint), `3.14f` (number), `'hello'` (text), `null`, `true`/`false`, `xdead` (blob)

### Testing

34 tests covering:
- All literal types with type discrimination (bigint vs real)
- Column references fingerprint by attribute ID, not name
- Parameter references (named and indexed)
- Unary and binary operators
- Commutativity for commutative operators, non-commutativity for others
- Scalar and aggregate function calls (including distinct flag)
- CASE, CAST, COLLATE, BETWEEN expressions
- Non-deterministic guard producing unique fingerprints
- Nested/deep expression consistency
