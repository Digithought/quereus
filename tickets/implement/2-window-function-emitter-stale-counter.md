description: Remove dead standalone window function emitter (Option A)
dependencies: none
files:
  packages/quereus/src/runtime/emit/window-function.ts (deleted)
  packages/quereus/src/runtime/register.ts (import + registration removed)
----
## Analysis

Verified that `WindowFunctionCallNode` is **never independently emitted**:

1. `buildExpression` (expression.ts:180) creates `WindowFunctionCallNode` nodes
2. `analyzeSelectColumns` (select-projections.ts:125) collects them into `windowFunctions`
3. `buildWindowPhase` (select-window.ts:16) wraps all into `WindowNode` instances
4. `WindowNode.getChildren()` does NOT expose `functions` — `emitWindow` accesses them directly
5. The standalone `emitWindowFunctionCall` emitter was unreachable dead code

## Changes Made

- **Deleted** `packages/quereus/src/runtime/emit/window-function.ts` — the dead emitter file
- **Removed** import and `registerEmitter(PlanNodeType.WindowFunctionCall, ...)` from `register.ts`
- **Kept** `PlanNodeType.WindowFunctionCall` enum value and `WindowFunctionCallNode` class (used by planner, characteristics detector, and `emitWindow`)

## Testing

- Build passes
- All 182 window-related tests pass (1 pre-existing unrelated failure in `emit-missing-types.spec.ts`)
