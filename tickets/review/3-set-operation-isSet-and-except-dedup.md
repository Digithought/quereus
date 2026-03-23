description: Fix SetOperationNode.getType() returning isSet:true for UNION ALL, and add dedup to EXCEPT emitter
dependencies: none
files:
  packages/quereus/src/planner/nodes/set-operation-node.ts
  packages/quereus/src/runtime/emit/set-operation.ts
  packages/quereus/test/logic/09-set_operations.sqllogic
----

## Summary

Two defects fixed in set operation handling:

### 1. `isSet` unconditionally true for all set operations

`SetOperationNode.getType()` returned `isSet: true` for all operations including UNION ALL. Fixed to `isSet: this.op !== 'unionAll'`, matching the pattern in `recursive-cte-node.ts`. UNION ALL preserves duplicates, so `isSet` must be `false` to prevent the optimizer from incorrectly skipping dedup downstream.

### 2. EXCEPT emitter missing dedup

`runExcept` yielded all left rows not in the right set without deduplication. Per SQL standard, EXCEPT (without ALL) returns distinct rows. Added a `yielded` BTree to track already-yielded rows, mirroring the existing `runIntersect` pattern.

## Test cases

- `VALUES (1),(1),(2) EXCEPT VALUES (2) ORDER BY value` → `[1]` (was incorrectly returning `[1,1]`)
- `VALUES ('a'),('a'),('a'),('b'),('c') EXCEPT VALUES ('b') ORDER BY value` → `['a','c']`
- All existing set operation tests continue to pass
