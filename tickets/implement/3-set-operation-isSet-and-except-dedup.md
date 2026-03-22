description: Fix SetOperationNode.getType() returning isSet:true for UNION ALL, and add dedup to EXCEPT emitter
dependencies: none
files:
  packages/quereus/src/planner/nodes/set-operation-node.ts
  packages/quereus/src/runtime/emit/set-operation.ts
  packages/quereus/test/logic/09-set_operations.sqllogic
----

## Defect 1: `isSet` unconditionally true

`SetOperationNode.getType()` (line 42-45) returns `{ ...leftType, isSet: true }` for all set operations including `unionAll`. UNION ALL preserves duplicates so `isSet` should be `false`. The `isSet` flag propagates to downstream nodes (joins, projections, CTEs, windows) and could cause the optimizer to skip dedup.

**Fix** in `set-operation-node.ts` line 44:
```typescript
return { ...leftType, isSet: this.op !== 'unionAll' } as RelationType;
```

Reference: `recursive-cte-node.ts` line 74 uses the same pattern: `isSet: !this.isUnionAll`.

## Defect 2: EXCEPT emitter missing dedup

`runExcept` in `set-operation.ts` (lines 99-124) yields all left rows not found in the right set, but doesn't deduplicate. Per SQL standard, EXCEPT (without ALL) returns distinct rows.

Reproducing case (confirmed failing):
```sql
SELECT value FROM (VALUES (1), (1), (2)) AS t1(value)
EXCEPT
SELECT value FROM (VALUES (2)) AS t2(value)
ORDER BY value;
-- Expected: 1 row: [1]
-- Actual:   2 rows: [1, 1]
```

**Fix** in `runExcept`: add a `yielded` BTree (same pattern as `runIntersect` lines 79-82) to track already-yielded rows:
```typescript
const yielded = new BTree<Row, Row>(
  (row: Row) => row,
  collationRowComparator
);

for (const outputRow of leftRowsArray) {
  const rightPath = rightTree.find(outputRow);
  if (!rightPath.on) {
    const yieldedPath = yielded.insert(outputRow);
    if (yieldedPath.on) {
      yield outputRow;
    }
  }
}
```

## TODO

- Fix `getType()` in `set-operation-node.ts:44` to return `isSet: this.op !== 'unionAll'`
- Add `yielded` BTree dedup to `runExcept` in `set-operation.ts` (mirror `runIntersect` pattern)
- Add test cases to `09-set_operations.sqllogic`:
  - EXCEPT with duplicate left-side rows expects deduplication: `VALUES (1),(1),(2) EXCEPT VALUES (2)` → `[1]`
  - EXCEPT with multiple duplicates: `VALUES ('a'),('a'),('a'),('b'),('c') EXCEPT VALUES ('b')` → `['a','c']`
- Run tests to confirm all pass
