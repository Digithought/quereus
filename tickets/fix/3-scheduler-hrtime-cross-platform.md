description: Scheduler metrics use Node-only process.hrtime.bigint() — breaks browser/RN
dependencies: none
files:
  packages/quereus/src/runtime/scheduler.ts
----
## Problem

`Scheduler.runInstructionWithMetrics()` and `runInstructionWithMetricsAsync()` call `process.hrtime.bigint()` (8 call sites) for nanosecond timing. This API is Node.js-specific and does not exist in browsers or React Native environments.

When `enableMetrics` is true (via the `runtime_stats` database option), execution in a non-Node environment will crash with a `process is not defined` or `process.hrtime is not a function` error.

The `InstructionRuntimeStats.elapsedNs` field is typed as `bigint`, which couples the type to the Node API's return type.

## Suggested Fix

Add a cross-platform high-resolution timer utility (e.g. in `src/util/` or `src/common/`) that:
- Uses `process.hrtime.bigint()` when available (Node)
- Falls back to `performance.now()` (browsers, RN) converted to nanosecond bigint
- Falls back to `Date.now()` as a last resort

Alternatively, change `elapsedNs` to millisecond `number` using `performance.now()` which is available in all target environments.

## TODO
- Create a cross-platform `hrtime()` utility
- Replace all 8 `process.hrtime.bigint()` calls in scheduler.ts
- Update `InstructionRuntimeStats.elapsedNs` type if needed
- Add a test verifying metrics collection works
