description: Replace Node-only process.hrtime.bigint() in scheduler with cross-platform utility
dependencies: none
files:
  packages/quereus/src/util/hrtime.ts           (new — cross-platform timer utility)
  packages/quereus/src/runtime/scheduler.ts      (replace 8 call sites)
  packages/quereus/test/cross-platform/env-compat.spec.ts  (remove PROCESS_EXCEPTIONS entry)
----

## Context

`Scheduler.runInstructionWithMetrics()` and `runInstructionWithMetricsAsync()` call
`process.hrtime.bigint()` (8 call sites) for nanosecond timing.  This API is Node-only
and will crash in browsers/RN when `enableMetrics` is true.

The `InstructionRuntimeStats.elapsedNs` field is typed `bigint`.
The only internal consumer is `logAggregateMetrics()` which divides by `1000n` to get μs.
The field is also exposed via the public `getMetrics()` method.

## Approach

Create `src/util/hrtime.ts` exporting a single function `hrtimeNs(): bigint` that:

1. **On module load**, detects the best available timer and assigns a fast-path function:
   - `process.hrtime.bigint()` when `typeof process !== 'undefined' && typeof process.hrtime?.bigint === 'function'` — nanosecond precision, Node-only
   - `performance.now()` (via globalThis) converted to bigint nanoseconds — microsecond precision, available in browsers, Node, and RN
   - `Date.now()` converted to bigint nanoseconds — millisecond precision, last resort

2. The detection runs once at import time; subsequent calls go through the cached fast-path
   with zero branching overhead.

3. The `typeof process` guard satisfies the env-compat audit's guard-pattern check, so
   the `PROCESS_EXCEPTIONS` entry for `runtime/scheduler.ts` should be **removed**
   (the scheduler will no longer reference `process` at all).

### Why this preserves the existing API

- `InstructionRuntimeStats.elapsedNs` stays `bigint` — no type change needed.
- `logAggregateMetrics()` division `/ 1000n` still works.
- Callers of `getMetrics()` see the same shape.
- The only change is precision: microsecond instead of nanosecond on non-Node platforms,
  which is perfectly adequate for instruction-level metrics.

### Pattern reference

The planner trace (`src/planner/framework/trace.ts`) already uses `performance.now()`
for millisecond timing.  This utility is the bigint-nanosecond equivalent.

## TODO

### Phase 1 — utility
- Create `packages/quereus/src/util/hrtime.ts` with `hrtimeNs(): bigint`
  - Module-level detection: `process.hrtime.bigint` → `performance.now` → `Date.now`
  - Guard `process` access with `typeof process !== 'undefined'`
  - Convert `performance.now()` ms float to ns bigint via `BigInt(Math.round(value * 1e6))`
  - Convert `Date.now()` ms integer to ns bigint via `BigInt(value) * 1_000_000n`

### Phase 2 — scheduler integration
- In `scheduler.ts`: `import { hrtimeNs } from '../util/hrtime.js';`
- Replace all 8 `process.hrtime.bigint()` calls with `hrtimeNs()`
  - Line 391: `runInstructionWithMetrics` start
  - Line 403: promise .then elapsed
  - Line 406: promise .catch elapsed
  - Line 412: sync success elapsed
  - Line 416: sync error elapsed
  - Line 423: `runInstructionWithMetricsAsync` start
  - Line 431: async success elapsed
  - Line 434: async error elapsed

### Phase 3 — env-compat cleanup
- In `test/cross-platform/env-compat.spec.ts`: remove the `PROCESS_EXCEPTIONS` entry for `runtime/scheduler.ts` (line 44)
  - The scheduler no longer uses `process` directly
  - The new `util/hrtime.ts` will pass the guard-pattern check (`typeof process` within 5 lines)

### Phase 4 — tests
- Add a unit test `test/util/hrtime.spec.ts` verifying:
  - `hrtimeNs()` returns a bigint
  - Two successive calls have non-decreasing values
  - The difference between two calls ~100ms apart is in the right ballpark (80–200ms in ns)
- Verify the existing `runtime-scheduler-modes.spec.ts` metrics mode test still passes
- Verify `env-compat.spec.ts` passes with the exception removed
- Run `yarn build` and `yarn test` in the quereus package
