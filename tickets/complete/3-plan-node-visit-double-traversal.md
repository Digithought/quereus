description: Fixed PlanNode.visit() and getTotalCost() double-traversal of relational children
files:
  packages/quereus/src/planner/nodes/plan-node.ts
  packages/quereus/test/planner/plan-node-traversal.spec.ts
----

## What was built

`PlanNode.visit()` and `getTotalCost()` previously iterated both `getChildren()` and
`getRelations()`, causing relational children to be visited/costed twice (since `getRelations()`
returns a subset of `getChildren()`). Both methods were simplified to traverse only `getChildren()`.

- `visit()`: single traversal via `getChildren()` — no duplicate visits
- `getTotalCost()`: purely additive `estimatedCost + sum(children.getTotalCost())` — no
  multiplicative cost inflation from `getRelations()`

## Testing

Three tests in `test/planner/plan-node-traversal.spec.ts`:

1. **visit() no double-visit** — FilterNode with mixed relational + scalar children; asserts each
   node visited exactly once.
2. **getTotalCost() additive** — Asserts `getTotalCost() == estimatedCost + sum(children.getTotalCost())`
   for every node in the tree.
3. **visit() subquery no double-visit** — ExistsNode where `getChildren()` and `getRelations()`
   overlap; asserts no double-visits.

## Known separate concern

Several node constructors (e.g., FilterNode) set `estimatedCost` to include children's total cost
via `source.getTotalCost()`, despite the field's JSDoc saying "excluding its children." This causes
`getTotalCost()` to still double-count through `estimatedCost` + recursive sum. This is a separate
issue from the `getRelations()` double-traversal fixed here.
