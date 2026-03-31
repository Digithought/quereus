description: Extract shared logic from JoinNode / BloomJoinNode / MergeJoinNode to reduce duplication
files:
  packages/quereus/src/planner/nodes/join-utils.ts       # NEW — shared plan-node utilities
  packages/quereus/src/planner/nodes/join-node.ts
  packages/quereus/src/planner/nodes/bloom-join-node.ts
  packages/quereus/src/planner/nodes/merge-join-node.ts
  packages/quereus/src/runtime/emit/join-output.ts       # NEW — shared emitter helper
  packages/quereus/src/runtime/emit/join.ts
  packages/quereus/src/runtime/emit/bloom-join.ts
  packages/quereus/src/runtime/emit/merge-join.ts
----

## Summary

Extracted duplicated logic from three join plan-node classes and three join emitters into shared utility modules.

### Plan-node utilities (`join-utils.ts`)

- `buildJoinAttributes(leftAttrs, rightAttrs, joinType, preserveAttributeIds?)` — shared `buildAttributes()` logic for all three join nodes. Handles semi/anti (left-only), preserveAttributeIds passthrough, and nullable marking for outer joins.
- `buildJoinRelationType(leftType, rightType, joinType, keys?)` — shared `getType()` logic. Combines columns, computes `isSet`, merges `rowConstraints`. JoinNode passes `combineJoinKeys(...)` for keys; BloomJoinNode/MergeJoinNode pass `[]`.
- `estimateJoinRows(leftRows, rightRows, joinType)` — shared `estimatedRows` logic with full switch covering all join types. **Fixes** missing `right`/`full` cases in BloomJoinNode and MergeJoinNode (previously fell through to default `leftRows * rightRows * 0.1`).
- `EquiJoinPair` interface — moved from `bloom-join-node.ts`; re-exported from `bloom-join-node.ts` to preserve external imports.

### Emitter output helper (`join-output.ts`)

- `joinOutputRow(joinType, matched, isSemiOrAnti, leftRow, rightColCount, rightSlot)` — shared post-match output logic for semi/anti yields and LEFT JOIN null-padding. All three emitters replaced their 7-line post-match block with a 2-line call.

## Testing notes

- Build passes: `yarn build`
- All 1130 tests pass (2 pre-existing pending): `yarn workspace @quereus/quereus test`
- No new tests needed — this is a pure refactor (plus the `right`/`full` estimateJoinRows fix for bloom/merge)
- Key test coverage: `11-joins.sqllogic`, `82-bloom-join.sqllogic`, `83-merge-join.sqllogic`, `08.1-semi-anti-join.sqllogic`

## Usage

No API changes. All exports preserved. `EquiJoinPair` can now be imported from either `join-utils.js` or `bloom-join-node.js` (re-export).
