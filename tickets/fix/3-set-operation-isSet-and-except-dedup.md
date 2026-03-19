description: SetOperationNode.getType() returns isSet:true for UNION ALL; EXCEPT emitter doesn't deduplicate
dependencies: none
files:
  packages/quereus/src/planner/nodes/set-operation-node.ts
  packages/quereus/src/runtime/emit/set-operation.ts
  packages/quereus/test/logic/09-set_operations.sqllogic
----
## Defect 1: isSet unconditionally true

`SetOperationNode.getType()` returns `{ ...leftType, isSet: true }` for all set operations including `unionAll`. UNION ALL preserves duplicates, so `isSet` should be `false` for that case. The `isSet` flag propagates through downstream nodes (joins, projections, CTEs, windows) and could cause the optimizer to skip needed deduplication steps.

Fix: conditionally set `isSet` based on the operation:
```typescript
getType(): RelationType {
    const leftType = this.left.getType();
    return { ...leftType, isSet: this.op !== 'unionAll' } as RelationType;
}
```

## Defect 2: EXCEPT emitter missing dedup

In `emitSetOperation`, the `runExcept` function collects all left rows, builds the right set, then yields left rows not in right. However, if the left side contains duplicate rows that aren't in the right, all duplicates are yielded. Per SQL standard, EXCEPT (without ALL) should return distinct results.

Example failing case:
```sql
SELECT value FROM (VALUES (1), (1), (2)) AS t1(value)
EXCEPT
SELECT value FROM (VALUES (2)) AS t2(value)
-- Expected: 1 row: [1]
-- Actual:   2 rows: [1, 1]
```

Fix: track yielded rows with a BTree (same pattern as `runIntersect`).

## Existing test coverage

`09-set_operations.sqllogic` has comprehensive set operation tests but uses PRIMARY KEY tables and distinct VALUES, so the EXCEPT dedup bug isn't triggered.

## TODO

- Fix `getType()` to return `isSet: false` for `unionAll`
- Add dedup tracking to `runExcept` in emitter
- Add test case for EXCEPT with duplicate left-side rows
