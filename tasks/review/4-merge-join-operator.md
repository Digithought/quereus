---
description: Merge join operator for sorted inputs — review implementation
dependencies: BloomJoinNode, optimizer physical selection rule
---

## Summary

Implemented a merge join operator that exploits pre-sorted inputs to perform equi-joins in a single linear pass. The optimizer selects merge join when it's cheaper than both hash join and nested loop, inserting SortNodes when inputs aren't already ordered.

### Files Changed

| File | Change |
|------|--------|
| `src/planner/cost/index.ts` | Added `MERGE_JOIN_PER_ROW` constant (0.3) and `mergeJoinCost()` function |
| `src/planner/nodes/merge-join-node.ts` | **New** — `MergeJoinNode` implementing `BinaryRelationalNode`, `JoinCapable`, `PredicateSourceCapable` |
| `src/runtime/emit/merge-join.ts` | **New** — Merge join emitter with sorted merge algorithm, run detection for duplicate keys, LEFT JOIN null-padding, residual condition evaluation |
| `src/runtime/register.ts` | Registered `PlanNodeType.MergeJoin` → `emitMergeJoin` |
| `src/planner/rules/join/rule-join-physical-selection.ts` | Extended to three-way cost comparison (nested-loop vs hash vs merge), detects existing ordering via `PlanNodeCharacteristics.getOrdering()`, inserts SortNodes when needed |

### Design Decisions

- **MergeJoinNode** follows BloomJoinNode structure exactly (same interfaces, same attribute/type/physical logic)
- **Ordering preservation**: merge join preserves left-side ordering in `computePhysical()` (unlike hash join which destroys ordering)
- **Optimizer heuristic**: checks both sides for existing ordering, computes merge cost with/without sort overhead, compares against hash and NL costs
- **Emitter approach**: materializes right side into array for run detection; streams left side and uses a pointer into the right array. This avoids complex two-iterator state management while still being efficient for sorted data.

### Testing

- `test/logic/83-merge-join.sqllogic` — comprehensive test suite covering:
  - Basic INNER and LEFT equi-joins
  - Multi-column equi-joins
  - NULL key handling (NULLs don't match)
  - Empty table edge cases (both sides)
  - Text column joins
  - USING clause
  - Duplicate key runs (cross-product verification)
  - LEFT JOIN semantics with small/large side
  - NOCASE collation handling
- All 669 existing tests continue to pass
- Build succeeds cleanly

### Validation

- `npm run build` — clean success
- Full test suite: 669 passing, 0 failing, 7 pending (pre-existing)
