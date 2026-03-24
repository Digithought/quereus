description: Extract shared logic from JoinNode / BloomJoinNode / MergeJoinNode to reduce duplication
dependencies: none
files:
  packages/quereus/src/planner/nodes/join-node.ts
  packages/quereus/src/planner/nodes/bloom-join-node.ts
  packages/quereus/src/planner/nodes/merge-join-node.ts
  packages/quereus/src/runtime/emit/join.ts
  packages/quereus/src/runtime/emit/bloom-join.ts
  packages/quereus/src/runtime/emit/merge-join.ts
----
The three join plan node classes and their corresponding emitters contain significant near-identical code.

### Plan node duplication

`buildAttributes()`, `getType()`, and the `estimatedRows` getter are near-identical across `JoinNode`, `BloomJoinNode`, and `MergeJoinNode`. Key differences:

- BloomJoinNode and MergeJoinNode support `preserveAttributeIds`
- BloomJoinNode and MergeJoinNode return `keys: []` in `getType()` (vs `combineJoinKeys` in JoinNode)
- MergeJoinNode's `computePhysical` preserves left-side ordering
- BloomJoinNode and MergeJoinNode are missing explicit `right`/`full` cases in `estimatedRows` (falls to default)

Candidate extractions:
- A shared `buildJoinAttributes(leftAttrs, rightAttrs, joinType, preserveAttributeIds?)` utility
- A shared `buildJoinType(leftType, rightType, joinType, combineKeys?)` utility
- A shared `estimateJoinRows(leftRows, rightRows, joinType)` utility

### Emitter duplication

The semi/anti/left join output pattern (check `matched`, yield left row for semi, yield left row for anti-not-matched, yield null-padded for left-unmatched) is identical across all three emitters. Could be extracted into a shared helper.

### Minor: missing `right`/`full` in physical node estimatedRows

BloomJoinNode and MergeJoinNode don't have explicit `right`/`full` cases. Currently unreachable (physical selection rule only handles inner/left/semi/anti), but should be added during any refactor for completeness.
