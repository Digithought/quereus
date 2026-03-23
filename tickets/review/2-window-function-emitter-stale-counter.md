description: Removed dead standalone window function emitter (Option A)
dependencies: none
files:
  packages/quereus/src/runtime/emit/window-function.ts (deleted)
  packages/quereus/src/runtime/register.ts (import + registration removed)
----
## Summary

Removed the unreachable `emitWindowFunctionCall` standalone emitter. `WindowFunctionCallNode` is never independently emitted — it's always handled inline by `emitWindow` via `WindowNode`. The standalone emitter in `window-function.ts` was dead code.

## What Changed

- **Deleted** `packages/quereus/src/runtime/emit/window-function.ts`
- **Removed** import and `registerEmitter(PlanNodeType.WindowFunctionCall, ...)` from `register.ts`
- **Kept** `PlanNodeType.WindowFunctionCall` enum value and `WindowFunctionCallNode` class (used by planner, characteristics detector, and `emitWindow`)

## Testing / Validation

- Build passes
- 329 tests pass (1 pre-existing unrelated failure in `10.1-ddl-lifecycle.sqllogic:248`)
- Window function tests all pass — verify that ROW_NUMBER, RANK, DENSE_RANK, LAG, LEAD, FIRST_VALUE, LAST_VALUE, NTILE, PERCENT_RANK, CUME_DIST, and frame clauses still work correctly
- Confirm no runtime path attempts to emit `WindowFunctionCallNode` independently (grep for `PlanNodeType.WindowFunctionCall` in emit code — should only appear in `window.ts` inline handling)
