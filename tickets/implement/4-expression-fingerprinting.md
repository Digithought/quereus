description: Expression fingerprinting infrastructure for common subexpression detection
dependencies: none
files:
  - packages/quereus/src/planner/analysis/expression-fingerprint.ts (new)
  - packages/quereus/src/planner/nodes/plan-node.ts (Attribute, ScalarPlanNode interfaces)
  - packages/quereus/src/planner/nodes/scalar.ts (UnaryOpNode, BinaryOpNode, LiteralNode, CaseExprNode, CastNode, CollateNode, BetweenNode)
  - packages/quereus/src/planner/nodes/function.ts (ScalarFunctionCallNode)
  - packages/quereus/src/planner/nodes/reference.ts (ColumnReferenceNode, ParameterReferenceNode)
  - packages/quereus/src/planner/nodes/aggregate-function.ts (AggregateFunctionCallNode)
  - packages/quereus/src/planner/nodes/plan-node-type.ts (PlanNodeType enum)
  - packages/quereus/src/planner/analysis/const-pass.ts (pattern reference for tree analysis)
  - packages/quereus/test/optimizer/ (test location)
----

## Expression Fingerprinting

Create a deterministic fingerprinting function for `ScalarPlanNode` trees that produces a canonical string identifying the computation performed. Two expression subtrees with the same fingerprint compute the same value given the same row input.

### Design

New file `packages/quereus/src/planner/analysis/expression-fingerprint.ts`.

#### Core function

```typescript
export function fingerprintExpression(node: ScalarPlanNode): string
```

Produces a canonical string by recursive descent over the scalar expression tree. The fingerprint encodes:

- **Node type** (from `PlanNodeType`)
- **Operator** (for `UnaryOpNode`, `BinaryOpNode`) - from `node.expression.operator`
- **Function name** (for `ScalarFunctionCallNode`) - from `node.expression.name`
- **Literal value** (for `LiteralNode`) - from `node.expression.value`, type-tagged
- **Attribute ID** (for `ColumnReferenceNode`) - from `node.attributeId`
- **Parameter reference** (for `ParameterReferenceNode`) - from `node.nameOrIndex`
- **Cast target type** (for `CastNode`) - from `node.expression.targetType`
- **Collation** (for `CollateNode`) - from `node.expression.collation`
- **BETWEEN negation** (for `BetweenNode`) - from `node.expression.not`
- **Children fingerprints** - recursed in order

Format: `NodeType(key-properties, child1-fingerprint, child2-fingerprint, ...)`

Example fingerprints:
- `length(name)` → `FN:length(CR:42)` (where 42 is attributeId for name)
- `length(name) > 5` → `BO:>(FN:length(CR:42),LI:5n)` (bigint literal)
- `CAST(x AS TEXT)` → `CA:TEXT(CR:7)`

#### Determinism guard

Only fingerprint expressions that are deterministic (`node.physical.deterministic !== false`). Non-deterministic expressions (e.g., `random()`, `now()`) must never be deduplicated. The function should return a unique non-matching value (e.g., the node's `id`) for non-deterministic nodes.

#### Commutativity (optional stretch)

For commutative operators (`+`, `*`, `=`, `!=`, `<>`, `AND`, `OR`), sort child fingerprints lexicographically before joining. This catches `a + b` and `b + a` as equivalent. Can defer to later if complex.

### Key constraints

- Must not depend on node identity (`.id`) except for the non-deterministic guard
- Must produce the same fingerprint for structurally identical expressions
- Must handle all `ScalarPlanNode` subtypes in the codebase
- Must be pure (no side effects, no mutation)
- Must handle aggregate function nodes (they should fingerprint based on function name, distinct flag, and operand fingerprints)

### Testing

Tests in `packages/quereus/test/optimizer/expression-fingerprint.test.ts`:
- Same expression structure produces same fingerprint
- Different expressions produce different fingerprints
- Column references fingerprint by attribute ID, not name
- Non-deterministic expressions produce unique fingerprints
- Nested expressions fingerprint recursively
- Literal types are distinguished (integer vs real vs text)

## TODO

- Create `packages/quereus/src/planner/analysis/expression-fingerprint.ts` with `fingerprintExpression()`
- Handle all scalar node types: Literal, ColumnReference, ParameterReference, UnaryOp, BinaryOp, ScalarFunctionCall, CaseExpr, Cast, Collate, Between, AggregateFunctionCall
- Add determinism guard for non-deterministic expressions
- Write unit tests in `packages/quereus/test/optimizer/expression-fingerprint.test.ts`
- Ensure build passes
