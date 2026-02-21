---
description: Review bloom (hash) join operator implementation
---

## Summary

Implemented a bloom (hash) join operator that replaces nested-loop joins for equi-join predicates, reducing O(n*m) to O(n+m) complexity.

### Changes Made

**New files:**
- `src/planner/nodes/bloom-join-node.ts` — Physical `BloomJoinNode` plan node (PlanNodeType.HashJoin)
- `src/runtime/emit/bloom-join.ts` — Emitter with build-phase materialization and probe-phase streaming
- `src/planner/rules/join/rule-join-physical-selection.ts` — Optimizer rule selecting hash vs nested-loop based on cost

**Modified files:**
- `src/runtime/register.ts` — Register bloom join emitter for PlanNodeType.HashJoin
- `src/planner/optimizer.ts` — Register physical join selection rule in PostOptimization pass (after QuickPick)
- `src/planner/rules/cache/rule-mutating-subquery-cache.ts` — Skip physical join nodes (they materialize inherently)
- `docs/optimizer.md` — Document physical join algorithm selection and bloom join
- `packages/quereus/README.md` — Mention bloom join in optimizer status

**Test files:**
- `test/logic/82-bloom-join.sqllogic` — Correctness tests: equi-join, multi-column, LEFT JOIN, NULL handling, empty inputs, USING clause, text keys, duplicate key runs
- `test/performance-sentinels.spec.ts` — Tightened self-join threshold from 8000ms to 500ms

### Testing

- All 665 tests pass (664 existing + 1 new bloom join test file)
- Performance sentinel: self-join of 50×1000 rows dropped from ~3500-4200ms to ~41ms (~90x improvement)
- All existing join correctness tests pass unchanged
- QuickPick join enumeration test passes (physical selection runs in PostOptimization, after QuickPick in Physical pass)
- Make sure we have no issues with custom collations - if so, could pull from binary stuff we implemented in the stores?

### Key Design Decisions

1. **PostOptimization pass placement**: Physical join selection runs in PostOptimization (after Physical pass) so QuickPick can see the full logical join tree before any physical conversion
2. **Map-based hash table**: Uses JS `Map<string, Row[]>` with type-tagged key serialization for correctness (null/type distinction)
3. **Build side = smaller input**: Optimizer ensures the smaller side is materialized into the hash map
4. **Residual conditions**: Non-equi parts of ON clause evaluated as residual filter after hash lookup
5. **USING clause support**: USING columns converted to equi-pairs at plan time

### Remaining Work (separate task)

- Merge join operator (`tasks/implement/3-merge-join-operator.md`)
