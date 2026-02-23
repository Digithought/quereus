---
description: Added LAG, LEAD, FIRST_VALUE, LAST_VALUE, PERCENT_RANK, CUME_DIST, NTILE runtime, RANGE BETWEEN
---

## Summary

Implemented the remaining window functions and RANGE BETWEEN value-based frames:

### New Functions
- **LAG(expr, offset?, default?)** / **LEAD(expr, offset?, default?)**: Navigation functions to access previous/following row values, with optional offset and default
- **FIRST_VALUE(expr)** / **LAST_VALUE(expr)**: Frame-based value functions returning first/last value in the window frame
- **PERCENT_RANK()**: Statistical ranking `(rank - 1) / (partition_size - 1)`, returns 0 for single-row partitions
- **CUME_DIST()**: Cumulative distribution `(last_peer_index + 1) / partition_size`
- **NTILE(n)**: Now fully functional at runtime (was registered but not handled in the switch/case)

### RANGE BETWEEN
- Frame bounds now properly distinguish ROWS vs RANGE mode
- RANGE CURRENT ROW includes all peer rows (same ORDER BY values)
- RANGE N PRECEDING/FOLLOWING uses value-based offsets on the first ORDER BY expression
- Default frame (ORDER BY present, no explicit frame) now correctly uses RANGE semantics with peer grouping

### Multi-arg Infrastructure
- `WindowNode.functionArguments` changed from `(ScalarPlanNode | null)[]` to `ScalarPlanNode[][]` — supports multiple arguments per function
- `buildWindowFunctionArguments()` in select-window.ts builds all args per function
- Runtime callback extraction reconstructs per-function arg groups from flattened list

## Files Changed
- `src/planner/nodes/window-node.ts` — multi-arg functionArguments type + getChildren/withChildren
- `src/planner/building/select-window.ts` — buildWindowFunctionArguments returns ScalarPlanNode[][]
- `src/func/builtins/builtin-window-functions.ts` — registered 6 new functions
- `src/schema/window-function.ts` — no changes (existing 'navigation'/'value' kinds already in place)
- `src/runtime/emit/window.ts` — core changes:
  - Multi-arg callback handling
  - `computeNavigationFunction()` for LAG/LEAD
  - `computeValueFunction()` for FIRST_VALUE/LAST_VALUE
  - Extended `computeRankingFunction()` for PERCENT_RANK, CUME_DIST, NTILE
  - RANGE BETWEEN support in `getFrameBounds()` with peer group helpers
  - `sortRows()` now returns pre-evaluated ORDER BY values for RANGE computation
- `docs/window-functions.md` — updated supported functions list and examples

## Testing
- All 684 existing tests pass
- New sqllogic tests in `test/logic/07.5-window.sqllogic`:
  - LAG/LEAD: basic, with offset, with default, across partition boundaries
  - FIRST_VALUE/LAST_VALUE: with explicit frame, default frame, no ORDER BY
  - PERCENT_RANK/CUME_DIST: with ties, single-row partition edge case
  - NTILE: buckets of 2, 3, 5
  - RANGE BETWEEN: CURRENT ROW peers, N PRECEDING/FOLLOWING, UNBOUNDED, FIRST_VALUE/LAST_VALUE with RANGE

## Validation
- `npx tsc --noEmit` passes
- `npm test` passes (684 passing, 7 pending, 0 failing)
