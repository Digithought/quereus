description: Replace Node-only process.hrtime.bigint() in scheduler with cross-platform hrtimeNs() utility
dependencies: none
files:
  packages/quereus/src/util/hrtime.ts                      (new — cross-platform timer)
  packages/quereus/src/runtime/scheduler.ts                (8 call sites replaced)
  packages/quereus/test/cross-platform/env-compat.spec.ts  (removed PROCESS_EXCEPTIONS entry)
  packages/quereus/test/util/hrtime.spec.ts                (new — unit tests)
----

## Summary

Created `src/util/hrtime.ts` exporting `hrtimeNs(): bigint` — a cross-platform high-resolution
timer that returns nanoseconds as a bigint. Detection runs once at import time with zero
branching on subsequent calls:

1. `process.hrtime.bigint()` — nanosecond precision (Node)
2. `performance.now()` → bigint ns — microsecond precision (browsers, RN)
3. `Date.now()` → bigint ns — millisecond precision (fallback)

All 8 `process.hrtime.bigint()` calls in `scheduler.ts` were replaced with `hrtimeNs()`.
The scheduler no longer references `process` directly, so the `PROCESS_EXCEPTIONS` entry
in `env-compat.spec.ts` was removed.

The `typeof process` guard in `hrtime.ts` satisfies the env-compat audit's guard-pattern check.

## API preservation

- `InstructionRuntimeStats.elapsedNs` stays `bigint` — no type change
- `logAggregateMetrics()` division `/ 1000n` still works
- `getMetrics()` returns the same shape
- Only precision changes on non-Node platforms (microsecond vs nanosecond)

## Testing

- `test/util/hrtime.spec.ts`: returns bigint, non-decreasing, ~100ms elapsed in ballpark
- `test/cross-platform/env-compat.spec.ts`: passes with exception removed
- Existing `runtime-scheduler-modes.spec.ts` metrics tests still pass
- Build passes, all 298 passing tests pass (1 pre-existing unrelated failure in bigint-mixed-arithmetic)
