---
description: Streaming fast paths for sliding-frame window functions — ROWS BETWEEN n PRECEDING AND m FOLLOWING, RANGE with literal numeric offset bounds. Extends rule-monotonic-window recognition and the runStreaming emitter so sliding-frame aggregates (SUM/COUNT/AVG/MIN/MAX/FIRST_VALUE/LAST_VALUE) stream instead of buffering.
files: packages/quereus/src/planner/rules/window/rule-monotonic-window.ts, packages/quereus/src/planner/nodes/window-node.ts, packages/quereus/src/runtime/emit/window.ts, packages/quereus/test/logic/07.5-window.sqllogic, docs/window-functions.md
---

## Architecture

The carrier ticket (`monotonic-window-fast-path`, complete) installed the streaming
fast path for ranking / navigation / FIRST_VALUE / LAST_VALUE / running aggregates
over the default `UNBOUNDED PRECEDING TO CURRENT ROW` frame. Anything else still
falls back to the buffered emitter (`processPartition`).

This follow-up extends streaming to **sliding** frames where both edges are
literal-bounded:

| Frame shape | Streaming approach |
| --- | --- |
| `ROWS BETWEEN n PRECEDING AND m FOLLOWING` (literal `n`, `m`, both ≥ 0) | sliding ring buffer of size `n + m + 1`; SUM/COUNT/AVG step+unstep, MIN/MAX recomputed from the buffer (simple), FIRST_VALUE returns buffer head, LAST_VALUE returns buffer tail |
| `RANGE BETWEEN <num> PRECEDING AND <num> FOLLOWING` (numeric ORDER BY[0], literal offsets) | sliding window over a value-deque; bounds advance on order-by value crossing; same step+unstep aggregator pattern |

Frames already streamed (default / `UNBOUNDED PRECEDING TO CURRENT ROW`) keep
their existing fast-path. Frames outside the sliding shapes above (e.g.
`UNBOUNDED PRECEDING AND m FOLLOWING`, `n PRECEDING AND UNBOUNDED FOLLOWING`,
`CURRENT ROW AND m FOLLOWING`) remain buffered for v1 — they're not in scope
here.

### Recognition (`rule-monotonic-window`)

A new `slidingAgg` variant joins `StreamingWindowFunctionMode`:

```ts
| {
    kind: 'slidingAgg';
    frameMode: 'rows' | 'range';
    /** Non-negative integer literal for ROWS; non-negative numeric literal for RANGE. */
    preceding: number;
    /** Same constraints as preceding. */
    following: number;
  }
```

`recognizeFunctionMode` gains a sliding-frame branch that fires when:

- `frame` is present, `frame.exclusion` is absent (or `'no others'`), `frame.end` is non-null.
- `frame.type === 'rows'` with `frame.start.type === 'preceding'` and `frame.end.type === 'following'` — both values are non-negative integer literals via `tryExtractNumericLiteral`.
- OR `frame.type === 'range'` with `preceding`/`following` bounds, both non-negative numeric literals; only fires when there's exactly one ORDER BY key (SQL standard: numeric RANGE offsets need a single numeric sort key).
- Function name is one of `sum`/`count`/`avg`/`min`/`max`/`first_value`/`last_value` (running aggregates plus value functions) and is not DISTINCT.
- LAG/LEAD/RANK/DENSE_RANK/ROW_NUMBER do not take frames (the rule keeps rejecting them when a frame is specified — same as today).

The existing `isDefaultEquivalentFrame` check stays as the precondition for
`runningAgg`/`lastValue`. Sliding recognition is independent and lives in its
own helper, e.g. `recognizeSlidingFrame(frame): { mode: 'rows'|'range'; preceding: number; following: number } | null`.

For `RANGE` mode, the existing rule already requires the leading ORDER BY key
to be a column reference matching `monotonicOn` direction. We additionally
require `node.orderByExpressions.length === 1` (the numeric-RANGE constraint).
The numeric type check for the ORDER BY column is best-effort — at runtime
non-numeric values flow through `Number(...)` coercion the same way the buffered
`findRangeOffsetStart` does today; we don't add a planner-time type guard.

### Runtime (`runStreaming` in `runtime/emit/window.ts`)

The streaming emitter already maintains a per-partition `queue` of pending
entries. Sliding frames extend this with:

- A new `slidingAgg` branch in the per-row switch inside `runStreaming`.
- New per-function state on `StreamingFuncState`:

  ```ts
  /** Sliding-frame buffer of {argVal, orderByVal0, entry} for the rows currently in or above the window. */
  slidingBuffer?: Array<{ argVal: SqlValue; orderByVal0: SqlValue; entry: StreamingRowEntry }>;
  /** Index in slidingBuffer of the leftmost entry not yet retired (== left edge of window for the *front* of slidingBuffer). */
  slidingLeft?: number;
  /** Running accumulator + count for incremental SUM/COUNT/AVG. */
  slidingAcc?: any;
  slidingCount?: number;
  ```

- New `closeSlidingFrame(state, funcContexts)` helper invoked at partition
  boundary: flush every entry whose right edge wasn't reachable.

#### ROWS sliding flow (`frameMode: 'rows'`)

For each arriving row at 0-based partition index `i`:

1. Push `{argVal, orderByVal0: null, entry}` onto `slidingBuffer`. Step the
   accumulator with `argVal` (SUM/COUNT/AVG only; MIN/MAX recompute later).
2. The entry whose window is now fully visible is the one at index
   `i - following` (it has its `following` rows in the buffer). If `i >= following`,
   compute its frame value:
   - **SUM/COUNT/AVG**: window = `slidingBuffer.slice(targetBufIdx - preceding_clamped, targetBufIdx + following + 1)`.
     Use the running accumulator (we'll have step+unstep maintained correctly)
     to read the value, then call `schema.final(acc, count)`.
   - **MIN/MAX**: scan the live window slice and recompute (simplest correct
     impl; ticket explicitly allows this fallback).
   - **FIRST_VALUE / LAST_VALUE**: return `argVal` of the buffer's head /
     tail entry within the live window slice. Empty-frame -> NULL.
3. Once `i - preceding - 1` falls below 0 we don't need the head yet; once
   `i - preceding > 0`, the head's argVal has aged out — unstep it (subtract
   from the running accumulator for SUM/COUNT/AVG; nothing for MIN/MAX since
   we recompute), and shift it off (or advance `slidingLeft`).

The buffer's effective live size is `min(i+1, preceding+1+following)`; it never
grows beyond `preceding + 1 + following + 1` transient entries. We store a
reference to the entry, so `fillSlot` works directly.

The "yield gate" already implemented (`while (state.queue.length > 0 &&
state.queue[0].pending === 0) yield`) handles emit ordering automatically once
slots fill.

For **frame clamping** at partition start (`i < preceding`) and end (last
partition row at index `last`, `i + following > last`): the SQL standard
clamps the frame to the partition. The buffer-slice approach naturally clamps
because we only have what we have. Empty frames (e.g. partition of 1 row,
frame `1 PRECEDING AND 1 PRECEDING`) yield `NULL` for SUM/MIN/MAX/FIRST/LAST
and `0` for COUNT — we delegate to `schema.final(null, 0)` which already
returns the right thing for COUNT, and explicit `null` for the others.

At partition close (`finalizePartition`): walk any remaining buffered entries
not yet finalized, compute their frame value with the truncated buffer, and
fill their slot. After that, the existing yield drain handles emission.

#### RANGE sliding flow (`frameMode: 'range'`)

Same shape as ROWS but window bounds are by ORDER BY value, not by row offset:

- `slidingBuffer` carries `orderByVal0 = Number(orderByValues[0])`.
- For row `i` arriving with value `v`, window for entry `j` is the contiguous
  range `[firstK : v_K >= v_j - preceding, lastK : v_K <= v_j + following]`.
- An entry can be finalized once the *next arriving row's* value is
  `> entry.orderByVal0 + following` (the right edge has passed). Until then,
  the entry remains pending. Track per-entry `rightDone: boolean`; when scanning
  newly arrived row `i` we walk back from the end of the buffer, marking entries
  whose right edge has now closed, and finalize them.
- Left edge: entries with `orderByVal0 < v - preceding` (where `v` is the
  newly-finalizing entry's value) are out of its window. We binary-search or
  linear-scan from the front to find them.

NULL ordering values: per SQL standard a NULL ORDER BY value is its own peer
group at the start (NULLS FIRST default for ASC, NULLS LAST for DESC) — but
they don't compare numerically. Treatment: NULLs in the value column do not
participate in any other row's RANGE window (the offset arithmetic doesn't
apply); each NULL row's own window contains exactly the contiguous run of NULLs
at the partition edge. Concretely: if the current row's `orderByVal0` is NULL
or non-finite (`!Number.isFinite`), build its window from the contiguous
NULL-or-non-finite peer span only.

#### Buffer ownership

Every entry in `slidingBuffer` is also in `state.queue` (entries don't get
shifted off the queue until all slots are filled). When we finalize an entry
via `fillSlot`, the queue's yield-gate immediately becomes eligible if all
functions for that entry have filled. So the standard emit loop at the end of
each iteration drains correctly without extra plumbing.

### Memory

`O(preceding + following + 1)` per function per partition (the `slidingBuffer`),
plus the queue of unfinalized entries (at most `following + 1` long for ROWS,
and bounded by the maximum value-window span for RANGE). Compared to buffered's
`O(N)` per partition this is a strict win for typical sliding-window queries
where `preceding + following << N`.

## Out-of-scope (deferred to future tickets)

- DISTINCT aggregates inside sliding frames.
- GROUPS frame mode (peer-group based offsets).
- Frame exclusion clauses (`EXCLUDE CURRENT ROW`, `EXCLUDE GROUP`, `EXCLUDE TIES`).
- Asymmetric / one-sided sliding frames (`UNBOUNDED PRECEDING AND m FOLLOWING`,
  `n PRECEDING AND UNBOUNDED FOLLOWING`, `CURRENT ROW AND m FOLLOWING`).
  These have the same streaming structure but a different recognition shape;
  they can be added by extending `recognizeSlidingFrame`.
- Monotonic-deque optimization for MIN/MAX (we recompute over the live slice
  in v1; switch to a deque in a follow-up if profiling shows hot spots).

## TODO

### Phase 1 — Rule extension
- In `packages/quereus/src/planner/nodes/window-node.ts`: add `slidingAgg`
  variant to `StreamingWindowFunctionMode`.
- In `packages/quereus/src/planner/rules/window/rule-monotonic-window.ts`:
  - Add `recognizeSlidingFrame(frame): { mode: 'rows'|'range'; preceding: number; following: number } | null`.
  - Extend the running-agg / first_value / last_value branches in
    `recognizeFunctionMode` so that when `frame` is non-default but matches
    a sliding shape, the function returns the new mode. Update the function's
    JSDoc / module-header comment to reflect the new accepted shapes.
  - For RANGE mode, additionally require the ORDER BY length to be exactly
    one (carry a flag from the caller, since `recognizeFunctionMode` currently
    doesn't see the ORDER BY shape — refactor: pass ORDER BY length, or do
    the check at the call site in `ruleMonotonicWindow` after a successful
    `recognizeFunctionMode`).
  - Validate non-negativity and integer-ness of ROWS offsets via
    `tryExtractNumericLiteral` (`Number.isInteger`, `>= 0`); for RANGE,
    require `Number.isFinite` and `>= 0` (allow non-integer numeric offsets).

### Phase 2 — ROWS runtime
- In `runtime/emit/window.ts`:
  - Extend `StreamingFuncState` with the sliding fields above.
  - Update `makeFuncState` to initialize `slidingBuffer = []`, `slidingAcc = null`,
    `slidingCount = 0` for `slidingAgg` mode.
  - In `runStreaming`'s per-row switch, add a `slidingAgg` branch with
    `frameMode === 'rows'` handling (push to buffer, step accumulator,
    finalize entry at `i - following`, age out at `i - preceding - 1`).
  - Add `finalizeSlidingTrailing(state, funcContexts)` invoked from
    `finalizePartition` to fill remaining entries with their truncated frames.
  - Reset sliding state on partition boundary (handled automatically by
    `freshPartitionState`).
- For SUM/COUNT/AVG: rely on `schema.step` + a new local
  `unstepRunningAgg(schema, acc, argVal): newAcc` helper. SUM and COUNT have
  trivial inverses; AVG composes as a SUM/COUNT pair (which the schema's
  state already tracks — verify by reading the SUM/AVG schema impls in
  `schema/window-function*` or wherever the registrations live, and pick
  the cleanest unstep). If a schema has no clean inverse, fall back to
  recomputing from the live slice (same path as MIN/MAX).
- For MIN/MAX/FIRST_VALUE/LAST_VALUE: ignore `slidingAcc`; recompute from the
  live buffer slice each time an entry finalizes.

### Phase 3 — RANGE runtime
- Add the RANGE branch to the `slidingAgg` switch. Maintain `orderByVal0` per
  buffer entry (already evaluated at row arrival — pass it through).
- On each new row, walk the buffer from the end backward to mark entries whose
  `orderByVal0 + following < newRow.orderByVal0` as right-closed, then
  finalize them.
- Handle NULL/non-finite ordering values per the spec above.
- Ensure the partition-end flush finalizes everything left.

### Phase 4 — Tests + docs
- Append to `packages/quereus/test/logic/07.5-window.sqllogic` a section
  "Streaming sliding-frame tests" with cases:
  - `ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING` for SUM, COUNT, AVG, MIN, MAX
    over `stream_t`. Cross-check expected values manually (3-row window).
  - Asymmetric: `ROWS BETWEEN 2 PRECEDING AND 0 FOLLOWING` (SUM).
  - One-sided right: `ROWS BETWEEN 0 PRECEDING AND 2 FOLLOWING` (SUM).
  - Edge clamping: window larger than partition (`ROWS BETWEEN 5 PRECEDING AND 5 FOLLOWING`).
  - PARTITION BY + sliding ROWS (`stream_t.grp`).
  - FIRST_VALUE / LAST_VALUE under sliding `ROWS BETWEEN n PRECEDING AND m FOLLOWING`.
  - `RANGE BETWEEN 10 PRECEDING AND 10 FOLLOWING` with numeric ORDER BY and
    peer ties (build a small table with duplicate value rows).
  - NULL ordering values in RANGE.
  - Disabled-rule sanity: same query with `tuning.disabledRules: ['monotonic-window']`
    must produce identical output (lifted from the existing `08-tuning.sqllogic`
    or wherever the disable-tests live — search for the existing pattern).
- Update `docs/window-functions.md` streaming table:
  - Move "Sliding frames" row from "no" to "yes" (with the supported shape
    list and the RANGE single-numeric-ORDER-BY caveat).
  - Add a short paragraph in "Streaming fast path" describing the sliding
    state machine (buffer + step/unstep, MIN/MAX recompute, RANGE right-edge
    closure on next-arrival).
- Run `yarn lint` (in `packages/quereus`) and `yarn test`.
