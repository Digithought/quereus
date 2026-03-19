description: PlanNode.visit() and getTotalCost() double-traverse relational children
dependencies: none
files:
  packages/quereus/src/planner/nodes/plan-node.ts
----
`PlanNode.visit()` iterates both `getChildren()` and `getRelations()`, but for all relational base classes and subquery nodes, the relational inputs appear in both, causing double-traversal.

### visit() double-visiting

```typescript
visit(visitor: PlanNodeVisitor): void {
    visitor(this);
    this.getChildren().forEach(child => child.visit(visitor));    // includes relational
    this.getRelations().forEach(relation => relation.visit(visitor)); // same relational children again
}
```

For a `FilterNode`: `getChildren()` returns `[source, predicate]`, `getRelations()` returns `[source]`. The source subtree is visited twice.

Affected node categories:
- All `UnaryRelationalBase` subclasses (Filter, Project, Sort, Distinct, etc.)
- All `BinaryRelationalBase` subclasses (Join nodes)
- `ScalarSubqueryNode`, `ExistsNode`, `InNode` (with source)

The only current caller (`debug.ts:105`) guards with a `Map.has()` check, so the double-visit is a no-op there. But the visitor pattern is general-purpose and future callers would silently get duplicate visits.

### getTotalCost() double-counting

```typescript
getTotalCost(): number {
    return (this.estimatedCost + this.getChildren().reduce((acc, child) => acc + child.getTotalCost(), 0))
        * (this.getRelations().reduce((acc, relation) => acc + relation.getTotalCost(), 0) || 1);
}
```

For relational nodes, the relational children's cost is both added (via `getChildren()`) and multiplied (via `getRelations()`). This results in cost = `(own + sourceCost) * sourceCost` which double-counts.

### Root cause

The design intent is ambiguous: should `getChildren()` return ALL children including relational ones? The default `getRelations()` filters from `getChildren()`, implying relations are a subset. But `visit()` and `getTotalCost()` treat them as disjoint sets.

### Recommended fix

Make `visit()` use only `getChildren()` (since it's the superset), and fix `getTotalCost()` to either use only `getChildren()` for additive cost, or explicitly separate scalar and relational children.

### TODO
- Audit all callers of `visit()` to confirm no code depends on the double-visiting
- Fix `visit()` to only iterate `getChildren()`
- Fix `getTotalCost()` to avoid double-counting relational children
- Add a test that verifies visit counts for a tree with relational + scalar children
