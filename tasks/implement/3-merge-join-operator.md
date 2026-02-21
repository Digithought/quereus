---
description: Merge join operator for sorted inputs and sorted-index materialization
dependencies: BloomJoinNode (4-bloom-join-operator.md), optimizer physical selection rule
---

## Architecture

A **merge join** exploits pre-sorted inputs to perform an equi-join in a single linear pass over both sides. When inputs aren't already sorted on the join keys, the optimizer weighs the cost of sorting both sides against hash join and nested loop alternatives.

This task also covers **materialized sorted index**: for large dense datasets where one side can be cheaply indexed (e.g., primary key order matches join key), the merge join avoids explicit materialization by leveraging existing ordering.

### Design

#### 1. MergeJoinNode (Physical Plan Node)

New file: `src/planner/nodes/merge-join-node.ts`

```
class MergeJoinNode extends PlanNode implements BinaryRelationalNode, JoinCapable
  nodeType = PlanNodeType.MergeJoin  (reuse existing enum)
  left: RelationalPlanNode    (sorted on join keys)
  right: RelationalPlanNode   (sorted on join keys)
  joinType: 'inner' | 'left'
  equiPairs: { leftAttrId: number, rightAttrId: number }[]
  residualCondition?: ScalarPlanNode
  preserveAttributeIds: Attribute[]
```

Similar to BloomJoinNode but requires both inputs sorted on equi-pair columns. The optimizer inserts SortNodes if needed (following the StreamAggregate pattern).

Cost: `sortCost(leftRows) + sortCost(rightRows) + (leftRows + rightRows) * MERGE_PER_ROW`
where `MERGE_PER_ROW` is a new cost constant (e.g., 0.3).

#### 2. Merge Join Emitter

New file: `src/runtime/emit/merge-join.ts`

Function: `emitMergeJoin(plan: MergeJoinNode, ctx: EmissionContext): Instruction`

Classic merge-join algorithm:
1. Advance both iterators in sorted order
2. When keys match, collect the "run" of equal keys from both sides
3. Produce cross-product of matching runs
4. LEFT JOIN: emit null-padded rows for left rows with no match

Pre-computation at emit time:
- Column indices for equi-pairs
- Typed comparators for join-key ordering (using `createTypedComparator`)
- Row descriptors and row slots

#### 3. Optimizer Integration

Extend `ruleJoinPhysicalSelection` (from bloom-join task) to also consider merge join:

**Selection heuristic:**
- If both inputs already ordered on join keys → merge join (cheapest, no sort overhead)
- If one input ordered → merge join if sort cost of other side + merge < hash join cost
- Otherwise → hash join for equi-joins, nested loop for non-equi

Add `MERGE_JOIN_PER_ROW` constant to `src/planner/cost/index.ts` and a `mergeJoinCost()` function.

#### 4. Cost Model Addition

In `src/planner/cost/index.ts`:
```
MERGE_JOIN_PER_ROW: 0.3      // Per-row merge comparison
```

```typescript
function mergeJoinCost(leftRows: number, rightRows: number, needsSortLeft: boolean, needsSortRight: boolean): number {
  let cost = (leftRows + rightRows) * MERGE_JOIN_PER_ROW;
  if (needsSortLeft) cost += sortCost(leftRows);
  if (needsSortRight) cost += sortCost(rightRows);
  return cost;
}
```

## Key Files

Same as bloom-join-operator.md plus:

| Component | File | Purpose |
|-----------|------|---------|
| SortNode | `src/planner/nodes/sort.ts` | May insert for pre-sorting |
| Sort emitter | `src/runtime/emit/sort.ts` | Pattern for sort emission |
| Comparison utils | `src/util/comparison.ts` | `createTypedComparator` for merge ordering |

## TODO

### Phase 1: Cost Model
- [ ] Add `MERGE_JOIN_PER_ROW` constant to `src/planner/cost/index.ts`
- [ ] Add `mergeJoinCost()` function

### Phase 2: MergeJoinNode
- [ ] Create `src/planner/nodes/merge-join-node.ts`
- [ ] Implement same interfaces as BloomJoinNode (BinaryRelationalNode, JoinCapable)
- [ ] Use `PlanNodeType.MergeJoin` from existing enum

### Phase 3: Merge Join Emitter
- [ ] Create `src/runtime/emit/merge-join.ts` with `emitMergeJoin()`
- [ ] Implement classic merge-join with run detection for duplicate keys
- [ ] Handle LEFT JOIN null-padding
- [ ] Handle residual condition evaluation
- [ ] Register emitter for `PlanNodeType.MergeJoin` in `register.ts`

### Phase 4: Optimizer Integration
- [ ] Extend `ruleJoinPhysicalSelection` to consider merge join
- [ ] Detect existing ordering on join keys via `PlanNodeCharacteristics.getOrdering()`
- [ ] Insert SortNodes when needed (following StreamAggregate pattern)
- [ ] Three-way cost comparison: nested-loop vs hash vs merge

### Phase 5: Tests
- [ ] Verify all existing join tests pass
- [ ] Add merge-join-specific tests: pre-sorted inputs, multi-column keys, LEFT JOIN, empty inputs, duplicate key runs
- [ ] Verify query_plan() shows MergeJoin when inputs are pre-sorted
