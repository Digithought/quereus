description: Add projection pruning optimizer rule to eliminate unused columns from ProjectNode
dependencies: optimizer framework, view expansion
files:
  - packages/quereus/src/planner/rules/retrieve/rule-projection-pruning.ts (new)
  - packages/quereus/src/planner/optimizer.ts
  - packages/quereus/src/planner/nodes/project-node.ts
  - packages/quereus/src/planner/nodes/plan-node.ts (Attribute, attribute ID collection)
  - packages/quereus/test/optimizer/projection-pruning.spec.ts (new)
  - packages/quereus/test/logic/08-views.sqllogic
----

## Problem

When a view is expanded inline, its full SELECT list is materialized even if the outer query only references a subset of columns. For example:

```sql
CREATE VIEW v AS SELECT id, name, email, category, value FROM t;
SELECT name FROM v WHERE id = 5;
```

The view expansion produces a ProjectNode with all 5 columns, but only `name` (and `id` for the filter) are actually needed. The unused `email`, `category`, and `value` projections add unnecessary computation.

## Design

Create a new structural rewrite rule that identifies ProjectNode instances where some output projections are not referenced by any ancestor node, and removes those projections.

### Algorithm

The rule operates on **ProjectNode** (top-down structural pass). For a given ProjectNode:

1. Collect the set of attribute IDs that are referenced by the ProjectNode's parent and all ancestor nodes. This requires walking up from the current position, but since the optimizer traverses top-down, we can instead work bottom-up: for each ProjectNode, collect which of its output attributes are actually consumed by its parent.

**Simpler approach (bottom-up):** Since rules operate on individual nodes, use the following strategy:
- When a ProjectNode's parent is another ProjectNode (common after view expansion), the inner ProjectNode can be pruned to only emit attributes referenced by the outer ProjectNode's projection expressions.
- More generally, for any parent node, collect attribute IDs referenced in the parent's scalar children and its parent chain.

**Practical first cut:** Focus on the specific pattern that arises from view expansion:
- `Project(outer) → Project(view) → ...` — prune the inner Project to only columns referenced by the outer Project's expressions.
- `Filter → Project(view) → ...` — the filter references some attribute IDs; the Project can be pruned to only those referenced by the filter + whatever the filter's parent needs.

Since rules see one node at a time, the most practical approach is a **Project-on-Project** merge/prune rule:
- When a ProjectNode's source is another ProjectNode, analyze which of the inner Project's output attributes are referenced by the outer Project's expressions, and remove unused inner projections.

### Safety

- Only prune projections from ProjectNode where `preserveInputColumns` is false, or when we can verify no downstream node references the pruned attributes.
- Attribute IDs are stable and tracked, so reference analysis is reliable.

## Key Tests

- View with many columns, outer query selects subset — verify pruned plan has fewer projections
- Ensure correctness: results are identical with and without pruning
- Join with view where only some view columns are used
- `SELECT count(*) FROM v` — all view projections could be pruned (only needs row count)

## TODO

- Create `rule-projection-pruning.ts` in `packages/quereus/src/planner/rules/retrieve/`
- Implement Project-on-Project pruning: when outer Project references only a subset of inner Project's outputs, remove unused inner projections
- Register rule in `optimizer.ts` under the Structural pass (priority ~19, after distinct-elimination but before predicate-pushdown)
- Add `projection-pruning.spec.ts` tests using `query_plan()` to verify reduced projection width
- Add a view projection pruning case to `08-views.sqllogic`
- Run build and tests
