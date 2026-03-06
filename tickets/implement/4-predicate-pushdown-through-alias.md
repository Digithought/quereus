description: Extend predicate pushdown to traverse AliasNode boundaries (enables view optimization)
dependencies: predicate pushdown rule (rule-predicate-pushdown.ts)
files:
  - packages/quereus/src/planner/rules/predicate/rule-predicate-pushdown.ts
  - packages/quereus/src/planner/nodes/alias-node.ts
  - packages/quereus/src/planner/optimizer.ts
  - packages/quereus/test/optimizer/predicate-pushdown.spec.ts
  - packages/quereus/test/logic/08-views.sqllogic
----

## Problem

When a view is expanded inline (in `buildFrom()` at `building/select.ts:348-402`), the result is wrapped in an `AliasNode` if the view has an alias in the FROM clause. The current predicate pushdown rule (`rule-predicate-pushdown.ts`) handles `SortNode`, `DistinctNode`, `ProjectNode`, and `RetrieveNode` — but not `AliasNode`.

This means that queries like:

```sql
CREATE VIEW v AS SELECT id, name FROM t WHERE category = 'A';
SELECT * FROM v WHERE id = 5;
```

produce a plan where `Filter(id=5)` sits above `AliasNode` → `ProjectNode` → `FilterNode(category='A')` → table access. The `id=5` predicate cannot be pushed through the AliasNode, preventing it from reaching the Retrieve/index access layer.

## Design

`AliasNode` is a trivially safe node for predicate pushdown — it only renames the `relationName` on attributes and doesn't change attribute IDs or column semantics. The predicate references attributes by ID, so pushing across AliasNode is always safe.

Add an `AliasNode` case to `tryPushDown()` in `rule-predicate-pushdown.ts`, following the same pattern as the existing `SortNode` and `DistinctNode` cases:

```typescript
// Across AliasNode (view boundary)
if (child instanceof AliasNode) {
    log('Pushing predicate below AliasNode');
    const under = child.source;
    const newUnder = new FilterNode(under.scope, under, predicate);
    return new AliasNode(child.scope, newUnder, child.alias);
}
```

This should be inserted before the existing `SortNode` case so it fires early during view expansion plan traversal.

## Key Tests

- `SELECT * FROM view WHERE <predicate>` — verify predicate pushes through Alias into the view's underlying plan
- Verify via `query_plan()` that the FILTER count is reduced (pushed into index seek)
- Ensure correctness: `SELECT * FROM v WHERE id = 5` returns the right rows
- Ensure qualified column references still resolve after pushdown (`SELECT v.name FROM v WHERE v.id = 5`)

## TODO

- Add `AliasNode` import and case to `tryPushDown()` in `rule-predicate-pushdown.ts`
- Add tests to `predicate-pushdown.spec.ts` with a view scenario using `query_plan()` to verify pushdown
- Add a view predicate pushdown case to `08-views.sqllogic` for correctness
- Run build and tests
