---
description: Review streaming sliding-frame window emitter for SUM/COUNT/AVG/MIN/MAX/FIRST_VALUE/LAST_VALUE under ROWS BETWEEN n PRECEDING AND m FOLLOWING and RANGE BETWEEN <num> PRECEDING AND <num> FOLLOWING. Implementation extends `rule-monotonic-window` recognition and adds a `slidingAgg` mode to `runStreaming`.
files: packages/quereus/src/planner/rules/window/rule-monotonic-window.ts, packages/quereus/src/planner/nodes/window-node.ts, packages/quereus/src/runtime/emit/window.ts, packages/quereus/test/logic/07.5-window.sqllogic, packages/quereus/test/optimizer/monotonic-window.spec.ts, docs/window-functions.md
---

## What was built

A new `slidingAgg` `StreamingWindowFunctionMode` joins the streaming family. The
rule fires for two sliding shapes:

| Shape | Recognized for |
| --- | --- |
| `ROWS BETWEEN n PRECEDING AND m FOLLOWING` (literal `n,m ≥ 0` integer) | SUM, COUNT, AVG, MIN, MAX, FIRST_VALUE, LAST_VALUE |
| `RANGE BETWEEN <num> PRECEDING AND <num> FOLLOWING` (literal non-negative numeric, single ORDER BY key) | same set |

Default-frame paths (`UNBOUNDED PRECEDING TO CURRENT ROW`) keep their existing
`runningAgg` / `firstValue` / `lastValue` branches unchanged. DISTINCT
aggregates, asymmetric sliding shapes (one side UNBOUNDED), and frame
exclusion remain explicitly out of scope and fall to the buffered path.

### Recognition (`rule-monotonic-window`)

- New `recognizeSlidingFrame(frame)` helper returns `{mode, preceding, following}`
  or null. ROWS requires non-negative integer offsets; RANGE requires
  non-negative finite numeric offsets.
- `recognizeFunctionMode` now accepts `orderByLength` and dispatches to
  `slidingAgg` when the frame matches a sliding shape and the function is in
  the recognized set. RANGE additionally requires `orderByLength === 1`.
- `FIRST_VALUE` / `LAST_VALUE` accept either the default-equivalent frame
  (caches first row's value / current-row pass-through, as before) **or** a
  sliding frame (returns frame head / tail).
- LAG/LEAD/RANK/DENSE_RANK/ROW_NUMBER continue to reject any explicit frame.

### Runtime (`runtime/emit/window.ts`)

`StreamingFuncState` gains a sliding sub-state:

- `slidingBuffer: Array<{argVal, orderByVal0}>` — per-function ring buffer.
- `slidingHead`, `slidingNextFinalizeIdx` — ROWS bookkeeping.
- `slidingAcc: {sum, count}` — ROWS step+unstep accumulator for SUM/COUNT/AVG.
- `slidingPending: StreamingRowEntry[]` — ROWS pending list.
- `slidingRangePending: SlidingRangePendingEntry[]` — RANGE pending list with
  `{v_j, isFinite, rightClosed}` per entry.

ROWS strategy:

- Each new row pushes its argVal into the buffer and steps the accumulator
  (SUM/COUNT/AVG); MIN/MAX/FIRST/LAST do not maintain incremental state.
- Pending entries finalize when `pending.length > following` (so the entry at
  `i - following` has its right edge in scope).
- Before each finalize, the buffer is left-trimmed: rows with index <
  `max(0, j - preceding)` are unstepped and shifted off.
- After the trim, the buffer slice exactly matches the entry's frame; the
  accumulator is the answer for SUM/COUNT/AVG; the slice is scanned for
  MIN/MAX/FIRST_VALUE/LAST_VALUE.
- Memory is `O(preceding + following + 1)` per function per partition.

RANGE strategy:

- Pending entries track `v_j = Number(orderByValues[0])` and an `isFinite`
  flag.
- On each new arrival, all pending entries whose right edge has been crossed
  by `v_arrive > v_j + following` (or whose non-finite peer span has ended)
  are marked `rightClosed`. Front-of-queue right-closed entries are then
  finalized in order.
- Finalization scans the buffer for rows with `v ∈ [v_j - preceding, v_j +
  following]` (finite `v_j`) or the contiguous non-finite peer span
  (non-finite `v_j`). All aggregates use this scan in v1 — no incremental
  acc — keeping NULL handling and per-entry frame variation simple.
- After each finalize, the buffer is front-trimmed to drop rows no longer
  needed by any remaining pending entry.

`finalizePartition` flushes any remaining pending entries with their right
edges clamped to the last partition row.

## Use cases / SQL examples

```sql
-- Centered moving average / sum (3-row window).
SELECT id, SUM(val) OVER (ORDER BY id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) AS s,
       AVG(val) OVER (ORDER BY id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) AS a
FROM stream_s;

-- Asymmetric (lookback only).
SELECT id, MAX(val) OVER (ORDER BY id ROWS BETWEEN 4 PRECEDING AND 0 FOLLOWING) AS roll_max FROM t;

-- Look-ahead window.
SELECT id, SUM(val) OVER (ORDER BY id ROWS BETWEEN 0 PRECEDING AND 2 FOLLOWING) AS upcoming FROM t;

-- Numeric RANGE (band around current value).
SELECT val, COUNT(*) OVER (ORDER BY val RANGE BETWEEN 10 PRECEDING AND 10 FOLLOWING) AS neighbours FROM r;

-- FIRST_VALUE / LAST_VALUE over a sliding frame.
SELECT id, FIRST_VALUE(val) OVER (ORDER BY id ROWS BETWEEN 2 PRECEDING AND 2 FOLLOWING) AS leader FROM t;
```

## Testing

- `packages/quereus/test/logic/07.5-window.sqllogic` — new "Streaming
  sliding-frame tests" section with: ROWS BETWEEN 1/1 for SUM/COUNT/AVG/MIN/MAX,
  asymmetric (2 PRECEDING / 0 FOLLOWING), one-sided right (0/2), edge clamping
  (5/5 over a 6-row partition), FIRST/LAST under sliding ROWS, single-row
  partition, sliding SUM with NULL argVals, RANGE BETWEEN 10/10 with peer ties,
  and NULL ordering values under RANGE.
- `packages/quereus/test/optimizer/monotonic-window.spec.ts` — new
  streaming-vs-buffered correctness checks (`disabledRules: ['monotonic-window']`)
  for sliding ROWS BETWEEN 1/1, asymmetric 2/0, and FIRST/LAST.
- `yarn lint` (no errors) and `yarn test` (2693 passing in main package, 16 in
  the monotonic-window spec) both green.

## Validation hints for review

- Confirm rule still rejects DISTINCT aggregates, asymmetric sliding shapes,
  and frame exclusion clauses.
- Confirm RANGE recognition rejects `orderByLength != 1`.
- Confirm `finalizePartition` flushes trailing pending entries before yielding
  the queue (look for the new `finalizeSlidingTrailing` loop).
- The buffer-trim invariants (ROWS: `slidingHead == max(0, j - preceding)`
  before computing entry j's value; RANGE: drop rows with v < oldest pending
  finite entry's left edge) are the load-bearing pieces.
- Step+unstep `slidingAcc` skips NULL argVals on both directions, matching the
  schema's null-skipping step semantics for SUM and COUNT.

## Out of scope (deferred)

- Asymmetric sliding shapes (`UNBOUNDED PRECEDING AND m FOLLOWING`,
  `n PRECEDING AND UNBOUNDED FOLLOWING`, `CURRENT ROW AND m FOLLOWING`).
- Monotonic-deque optimization for MIN/MAX in sliding mode (recompute is fine
  for typical small windows).
- DISTINCT aggregates inside sliding frames.
- GROUPS frame mode and frame exclusion clauses (`EXCLUDE CURRENT ROW`, etc.).
- Incremental acc maintenance for RANGE (we scan the buffer per finalize in v1).
