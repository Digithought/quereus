---
description: Review the monotonic-window streaming fast path — recognition rule + one-pass runtime emitter for ranking, LAG/LEAD, FIRST/LAST_VALUE, and running aggregates over a MonotonicOn input. Verify correctness, plan-shape preservation, and downstream-rule composition.
files: packages/quereus/src/planner/nodes/window-node.ts, packages/quereus/src/planner/rules/window/rule-monotonic-window.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/src/runtime/emit/window.ts, packages/quereus/src/util/ast-literal.ts, packages/quereus/test/optimizer/monotonic-window.spec.ts, packages/quereus/test/logic/07.5-window.sqllogic, docs/window-functions.md, docs/optimizer.md
---

## What was built

A new optimizer rule `monotonic-window` (registered in `PostOptimization` at priority 6) that recognises a `WindowNode` whose input already streams in `[PARTITION BY..., ORDER BY[0]]` order and tags it with a `streaming` config. The runtime (`emit/window.ts`) dispatches on this flag to a new `runStreaming` emitter that walks the source in source order, maintains O(P) per-partition state, and emits in source order — saving the O(N log N) sort and O(N) materialisation buffer the buffered path required.

### Plan-layer changes (`planner/nodes/window-node.ts`)

- Added `StreamingWindowFunctionMode` (discriminated union) and `StreamingWindowConfig` types.
- Added optional `streaming?: StreamingWindowConfig` field to `WindowNode`, propagated via `withChildren`.
- Added `withStreaming(config)` helper used by the rule.
- Updated `computePhysical()`: when `streaming` is set, preserve source's `monotonicOn` unchanged (the streaming runtime is row-pass-through). The buffered branches are unchanged.
- Surfaced the streaming config in `getLogicalAttributes` so EXPLAIN reports the per-function modes.

### Recognition rule (`planner/rules/window/rule-monotonic-window.ts`)

`ruleMonotonicWindow(node, ctx)` fires when **all** of:

- The leading ORDER BY key is a trivial `ColumnReferenceNode` whose attrId/direction matches a `physical.monotonicOn` entry on the source.
- Subsequent ORDER BY keys are also trivial column refs and are covered by `physical.ordering` in declared order/direction.
- All PARTITION BY expressions are trivial column refs and form an emit-order prefix of `physical.ordering`.
- Every function in the WindowNode is individually recognised:
  - `ROW_NUMBER`, `RANK`, `DENSE_RANK`
  - `LAG(expr [, n [, default]])`, `LEAD(expr [, n [, default]])` with `n` a non-negative integer literal (rejects column-ref offsets)
  - `FIRST_VALUE(expr)`, `LAST_VALUE(expr)` (latter only under default-equivalent frame)
  - `SUM` / `COUNT` / `AVG` / `MIN` / `MAX` over the default frame (or explicit `UNBOUNDED PRECEDING TO CURRENT ROW` in either ROWS or RANGE mode)
- No function is `DISTINCT`.

Bails on any sliding/explicit-bound frame, NTILE/PERCENT_RANK/CUME_DIST, mixed streaming-capable + non-capable functions in the same node, or partition-by misalignment.

The lifted `tryExtractNumericLiteral` helper now lives in `util/ast-literal.ts` (the runtime emitter imports the shared version).

### Runtime (`runtime/emit/window.ts`)

`emitWindow` dispatches on `plan.streaming`:

- buffered path (unchanged) when the flag is unset.
- `runStreaming` (new) when set.

`runStreaming` highlights:

- Manages its own source-attribute getter directly in `rctx.context` rather than via `createRowSlot`. Per iteration it re-promotes its descriptor to the end of the context map (delete-then-set) so it wins attribute-index resolution even when stacked Windows would otherwise shadow each other (an outer Window's slot is registered later and would otherwise hide the inner Window's per-row updates).
- Per-row pipeline: compute partition key + ORDER BY values; on partition or peer-group boundaries, finalise pending state (RANGE running-agg peer fills, LEAD trailing default fills, queue drain); allocate a per-row queue entry; update each function's state and fill what can be filled; promote slot to yielded row before each yield.
- Per-function helpers: `runRanking` inlined (single counter + last-key); `fillLag` (ring buffer of size `offset`); `handleLead` (read-ahead queue of size `offset`); `firstValue` (cache first row's expr); `lastValue` (current row's expr); `stepRunningAgg` (fold via existing `WindowFunctionSchema.step`/`final` hooks; defers slot fill until peer-group close in RANGE mode).
- `finalizePartition` flushes the trailing peer group, fills remaining LEAD slots with default, and yields queued entries.

State is bounded by `peer-group-size + max(LEAD offset)` per partition, which is data-dependent but rarely large.

### Tests

- `test/optimizer/monotonic-window.spec.ts` (new, 14 cases): positive cases verifying the streaming shape via `physical.monotonicOn` preservation; negative cases (non-column ORDER BY, mismatched partition prefix, NTILE, sliding frames, non-literal LAG offset); equivalence cases that disable the rule via `tuning.disabledRules` and assert identical output.
- `test/logic/07.5-window.sqllogic` (extended): added a streaming-fast-path section exercising ROW_NUMBER, RANK/DENSE_RANK, LAG (with non-NULL default), LEAD (with default at boundary), running SUM/MIN, FIRST_VALUE, LAST_VALUE, all-NULL expr, single-row partitions, empty result via `WHERE 1=0`.
- All existing window tests (42 of them) continue to pass unchanged.

### Docs

- `docs/window-functions.md` — new "Streaming fast path over MonotonicOn" subsection listing the recognised functions/frames and bail conditions.
- `docs/optimizer.md` — new "Monotonic streaming-window recognition" section under PostOptimization rules.

## Use cases for testing

1. **Basic ranking over PK**: `SELECT id, ROW_NUMBER() OVER (ORDER BY id) FROM t` — should emit no SORT/buffer, run in O(N).
2. **LAG with default**: `SELECT id, LAG(val, 1, -1) OVER (ORDER BY id) FROM t` — first row gets default `-1`.
3. **LEAD with default**: `SELECT id, LEAD(val, 2, 0) OVER (ORDER BY id) FROM t` — last two rows get default `0`.
4. **Running SUM with peer ties**: insert duplicate ORDER BY values; verify all peers get the same post-peer-group accumulator under default RANGE frame.
5. **ROWS UNBOUNDED PRECEDING (no peer buffering)**: `SUM(val) OVER (ORDER BY id ROWS UNBOUNDED PRECEDING)` — each row gets its post-step value immediately.
6. **Two stacked Windows**: separate functions with same OVER clause sometimes plan as two stacked WindowNodes; verify both stream and produce correct results (the slot-promotion logic exists for this).
7. **Rule disabled**: `tuning.disabledRules.add('monotonic-window')` → identical results, slower path.
8. **Composition with downstream rules**: `SELECT id FROM t ORDER BY id LIMIT 5` over a streaming window — verify the leaf's `monotonicOn` propagates through the WindowNode unchanged so `monotonic-limit-pushdown` would still fire on a leaf with `ordinalSeek`.

## Validation done

- `yarn tsc -p packages/quereus` — clean.
- `yarn run lint` (in `packages/quereus`) — clean.
- `yarn run test` (in `packages/quereus`) — 2637 passing, 2 pending, 0 failing (the previously-flaky `property-planner` timeout is unrelated and reproduces without these changes).

## Out-of-scope (deferred to follow-ups)

- Sliding frames — parked at `tickets/backlog/3-monotonic-window-sliding-frames.md`.
- `NTILE`, `PERCENT_RANK`, `CUME_DIST` — would need a two-pass streaming variant.
- DISTINCT aggregates inside windows.
- Splitting a mixed `WindowNode` (streaming-capable + non-streaming) into two stacked nodes so the streaming subset still benefits.
- Composite `monotonicOn` prefix recognition (multi-key streaming).
