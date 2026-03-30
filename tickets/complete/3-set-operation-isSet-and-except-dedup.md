description: Fix SetOperationNode.getType() returning isSet:true for UNION ALL, and add dedup to EXCEPT emitter
files:
  packages/quereus/src/planner/nodes/set-operation-node.ts
  packages/quereus/src/runtime/emit/set-operation.ts
  packages/quereus/test/logic/09-set_operations.sqllogic
----

## What was fixed

### 1. `isSet` unconditionally true for all set operations

`SetOperationNode.getType()` returned `isSet: true` for all operations including UNION ALL. Fixed to `isSet: this.op !== 'unionAll'`, matching the pattern in `recursive-cte-node.ts`. UNION ALL preserves duplicates, so `isSet` must be `false` to prevent the optimizer from incorrectly skipping dedup downstream.

### 2. EXCEPT emitter missing dedup

`runExcept` yielded all left rows not in the right set without deduplication. Per SQL standard, EXCEPT (without ALL) returns distinct rows. Added a `yielded` BTree to track already-yielded rows, mirroring the existing `runIntersect` pattern.

## Tests

- `VALUES (1),(1),(2) EXCEPT VALUES (2) ORDER BY value` → `[1]`
- `VALUES ('a'),('a'),('a'),('b'),('c') EXCEPT VALUES ('b') ORDER BY value` → `['a','c']`
- All existing set operation tests pass (121+ tests across the suite)

## Review notes

- `isSet` pattern consistent with `recursive-cte-node.ts:74` (`isSet: !this.isUnionAll`)
- `yielded` BTree in `runExcept` mirrors `runIntersect` (lines 79-96 in set-operation.ts)
- Docs (`sql.md`) already describe EXCEPT as "set semantics" — no updates needed
- Minor optimization opportunity: `runExcept` could build the right set first and stream left rows instead of collecting them into an array, saving O(n) memory
