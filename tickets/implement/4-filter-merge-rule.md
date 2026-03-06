description: Add optimizer rule to merge adjacent Filter nodes into a single AND-combined Filter
dependencies: optimizer framework, predicate pushdown
files:
  - packages/quereus/src/planner/rules/predicate/rule-filter-merge.ts (new)
  - packages/quereus/src/planner/optimizer.ts
  - packages/quereus/src/planner/nodes/filter.ts
  - packages/quereus/src/planner/nodes/plan-node-type.ts
  - packages/quereus/test/optimizer/filter-merge.spec.ts (new)
  - packages/quereus/test/logic/08-views.sqllogic
----

## Problem

View expansion combined with predicate pushdown can produce stacked Filter nodes:

```sql
CREATE VIEW v AS SELECT id, name FROM t WHERE category = 'A';
SELECT * FROM v WHERE value > 100;
```

After predicate pushdown, this may produce: `Filter(value > 100) → Filter(category = 'A') → TableAccess`. Two adjacent Filters are semantically equivalent to a single `Filter(value > 100 AND category = 'A')`, but the double filter adds plan complexity and an extra iteration boundary in the runtime.

## Design

Create a simple structural rewrite rule that merges adjacent FilterNodes:

```
Filter(pred_outer) → Filter(pred_inner) → source
becomes:
Filter(pred_outer AND pred_inner) → source
```

### Implementation

The rule targets `PlanNodeType.Filter`. When a FilterNode's source is also a FilterNode:
1. Create a new `BinaryExprNode` (or equivalent AND node) combining both predicates.
2. Return a new FilterNode with the combined predicate over the inner filter's source.

Use the existing `BinaryExprNode` with the `and` operator to combine predicates. The planner already has infrastructure for building AND expressions — look at how the predicate normalizer and constraint extractor create compound predicates.

### Placement

Register in the Structural pass with priority ~21 (just after predicate-pushdown at 20). This way, pushdown fires first to stack the filters, then merge cleans them up. The top-down traversal means that after pushdown creates stacked filters deeper in the tree, the next traversal pass will see them and merge.

Actually, since both rules run in the same top-down pass: predicate pushdown has priority 20, filter merge should have priority 21. The pass manager applies rules to each node in priority order, then moves to children. Since pushdown transforms the parent and may create a new child structure, the merge rule on the newly-formed stacked filters will be picked up when the traversal descends to the new child nodes.

### Safety

Always safe: `Filter(A) → Filter(B) → X` is semantically identical to `Filter(A AND B) → X`.

## Key Tests

- View with WHERE + outer WHERE → verify single Filter in plan
- Multiple stacked filters from complex view nesting → verify merge
- Ensure correctness: results match unoptimized execution
- Check via `query_plan()` that FILTER count is reduced

## TODO

- Create `rule-filter-merge.ts` in `packages/quereus/src/planner/rules/predicate/`
- Implement filter merge: when Filter's source is Filter, combine predicates with AND
- Register rule in `optimizer.ts` under Structural pass (priority 21, after predicate-pushdown)
- Add `filter-merge.spec.ts` tests
- Add a filter merge case to `08-views.sqllogic`
- Run build and tests
