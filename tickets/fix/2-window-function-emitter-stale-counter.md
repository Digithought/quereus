description: window-function.ts standalone emitter has stale mutable counter and incorrect rank/dense_rank
dependencies: none
files:
  packages/quereus/src/runtime/emit/window-function.ts
  packages/quereus/src/runtime/register.ts
----
## Defect

`emitWindowFunctionCall` is registered for `PlanNodeType.WindowFunctionCall` and has two issues:

1. **Stale counter across prepared statement re-executions**: The `rowCounter` variable is captured in a closure at emit time. Since emitted instructions are reused across multiple executions of a prepared statement, the counter never resets, producing ever-increasing values.

2. **Incorrect rank/dense_rank**: The `rank` and `dense_rank` implementations are simple incrementing counters that don't handle ties. They produce `row_number()` behavior instead.

The main window function path (`emitWindow` in `window.ts`) handles all of these correctly. This standalone emitter appears vestigial but is still registered and theoretically reachable.

## Fix Options

**Option A**: Remove the registration and the file if `WindowFunctionCallNode` is never independently emitted (it's always wrapped in a `WindowNode`). The emitter would become unreachable dead code.

**Option B**: If independent emission is needed, fix the counter to reset on each execution and implement proper rank/dense_rank with tie detection.

Option A is preferred — verify that `WindowFunctionCallNode` is always wrapped in `WindowNode` during planning, then remove the dead emitter.

## TODO

- Verify WindowFunctionCallNode is never independently emitted
- Either remove emitter+registration or fix the implementation
