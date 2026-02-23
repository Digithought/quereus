---
description: Key-driven row-count reduction with FK→PK inference and DISTINCT elimination
dependencies: None
---

## Summary

Implemented key-driven cardinality optimization across all join node types, FK→PK join inference, unique constraint propagation, and DISTINCT elimination.

### Changes

**Phase 1: DRY Join Key-Coverage Utility**
- Extracted `analyzeJoinKeyCoverage()` into `src/planner/util/key-utils.ts`
- Shared function checks both logical keys (`RelationType.keys`) and physical keys (`PhysicalProperties.uniqueKeys`)
- Refactored `JoinNode`, `BloomJoinNode`, and `MergeJoinNode` to use the shared utility
- **Critical fix**: `BloomJoinNode` and `MergeJoinNode` now set `estimatedRows` when key coverage is detected (previously they only set `uniqueKeys`)
- Added `extractEquiPairsFromCondition()` helper in `join-node.ts`

**Phase 2: FK & Unique Constraint Schema**
- Added `UniqueConstraintSchema` interface in `schema/table.ts`
- Uncommented `uniqueConstraints` on `TableSchema`
- Added `extractUniqueConstraints()` in `schema/manager.ts` — extracts both column-level and table-level UNIQUE constraints
- Wired into `buildTableSchemaFromAST()`
- Added unique constraint columns as additional keys in `RelationType` via `type-utils.ts`

**Phase 3: FK→PK Join Inference**
- Enhanced `CatalogStatsProvider.joinSelectivity()` with FK-aware selectivity (`1/ndv_pk` instead of `1/max(ndv_left, ndv_right)`)
- Added `fkPkSelectivity()`, `isFkColumn()`, `getPkDistinct()` helpers
- Updated `rule-join-key-inference.ts` to detect FK→PK alignment via schema lookup
- Added `extractTableSchema()` and `checkFkPkAlignment()` in `key-utils.ts`

**Phase 4: DISTINCT Elimination**
- New rule `rule-distinct-elimination.ts` removes redundant DISTINCT when source has logical or physical unique keys
- Registered in optimizer structural pass at priority 18

**Phase 5: Documentation**
- Updated `docs/optimizer.md` key-driven section with implementation details

### Key Files

| File | Change |
|------|--------|
| `src/planner/util/key-utils.ts` | Shared `analyzeJoinKeyCoverage`, `extractTableSchema`, `checkFkPkAlignment` |
| `src/planner/nodes/join-node.ts` | Refactored to use shared utility, added `extractEquiPairsFromCondition` |
| `src/planner/nodes/bloom-join-node.ts` | Refactored, now sets `estimatedRows` |
| `src/planner/nodes/merge-join-node.ts` | Refactored, now sets `estimatedRows` |
| `src/schema/table.ts` | Added `UniqueConstraintSchema`, uncommented `uniqueConstraints` |
| `src/schema/manager.ts` | Added `extractUniqueConstraints()` |
| `src/planner/type-utils.ts` | Unique constraints surfaced as additional `RelationType.keys` |
| `src/planner/stats/catalog-stats.ts` | FK→PK join selectivity |
| `src/planner/rules/join/rule-join-key-inference.ts` | FK→PK detection + logging |
| `src/planner/rules/distinct/rule-distinct-elimination.ts` | New DISTINCT elimination rule |
| `src/planner/optimizer.ts` | Register distinct-elimination rule |
| `docs/optimizer.md` | Updated key-driven section |

### Testing

- Extended `test/optimizer/keys-propagation.spec.ts` with 3 new tests:
  - Physical hash join node has key-driven `estimatedRows`
  - Unique constraint columns create additional keys in `RelationType`
  - DISTINCT elimination when source has unique keys
- New `test/logic/84-key-cardinality.sqllogic`:
  - FK→PK join correctness
  - DISTINCT on PK column (eliminated)
  - DISTINCT on non-key column (preserved)
  - Unique constraint join behavior
  - Multi-table join with key propagation

### Validation

- TypeScript: `tsc --noEmit` passes cleanly
- Tests: 8/8 key-propagation spec tests pass; 84-key-cardinality sqllogic passes
- Only pre-existing failure: `41-foreign-keys.sqllogic` (unrelated FK enforcement WIP)
