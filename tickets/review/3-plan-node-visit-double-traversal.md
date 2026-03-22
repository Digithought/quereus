description: Fix PlanNode.visit() and getTotalCost() double-traversal of relational children
dependencies: none
files:
  packages/quereus/src/planner/nodes/plan-node.ts
  packages/quereus/test/planner/plan-node-traversal.spec.ts
----

## Summary

`PlanNode.visit()` iterated both `getChildren()` and `getRelations()`, but for all relational
nodes, `getRelations()` returns a subset of `getChildren()`. This caused relational children
to be visited twice. Similarly, `getTotalCost()` both added children's costs (via `getChildren()`)
and multiplied by relations' costs (via `getRelations()`), causing exponential cost inflation.

## What changed

**`plan-node.ts` lines 163-172** — two methods simplified:

- `visit()`: Removed the second traversal of `getRelations()`. Now only iterates `getChildren()`,
  which is the complete set of children (relational + scalar).

- `getTotalCost()`: Changed from `(own + childrenSum) * (relationsSum || 1)` to a purely
  additive `own + childrenSum`. The multiplicative formula both added and multiplied relational
  children's costs, producing wildly inflated numbers (e.g., 31903 vs correct 252).

## Affected callers

- `debug.ts:105` `serializePlanTree()` — only caller of `visit()`. Already guarded with `Map.has()`,
  so double-visit was a no-op there. Now the guard is redundant but harmless.
- `rule-quickpick-enumeration.ts:107` `estimatePlanCost()` — uses `getTotalCost()` for join ordering.
  Was getting inflated costs that could cause suboptimal join orderings.
- All node constructors that call `source.getTotalCost()` to compute `estimatedCost` — these
  call it on fully-constructed children, so the fix doesn't affect constructor behavior.

## Testing

Three new tests in `test/planner/plan-node-traversal.spec.ts`:

1. **visit() no double-visit** — Uses `SELECT * FROM t WHERE id > 1` (FilterNode with mixed
   relational + scalar children). Counts visits per node, asserts each is visited exactly once.
2. **getTotalCost() additive** — Same query. For every node in the tree, asserts
   `getTotalCost() == estimatedCost + sum(children.getTotalCost())`.
3. **visit() subquery no double-visit** — Uses `EXISTS (subquery)` (ExistsNode where
   `getChildren()` and `getRelations()` both return `[subquery]`). Asserts no double-visits.

## Note: estimatedCost semantics

Several node constructors set `estimatedCost` to include children's total cost (e.g.,
`FilterNode: source.getTotalCost() + rows * predicate.getTotalCost()`), despite the
field's JSDoc saying "excluding its children." This means `getTotalCost()` still
double-counts through `estimatedCost` + recursive children sum. This is a separate
concern from the `getRelations()` double-traversal fixed here.
