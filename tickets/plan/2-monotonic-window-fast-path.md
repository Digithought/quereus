---
description: Fast paths for window functions over a monotonic order — LAG/LEAD as adjacent-leaf reads and running aggregates as streaming scans, when the windowed input is MonotonicOn the order key
prereq: monotonic-on-characteristic, bestaccessplan-monotonic-ordering
files: packages/quereus/src/planner/rules/, packages/quereus/src/runtime/emit/, packages/quereus/src/planner/nodes/ (window function nodes)

---

## Architecture

Window functions over a monotonic order — `LAG/LEAD`, running `SUM/COUNT/MIN/MAX/AVG`, ranking functions — currently execute through Quereus's window-function machinery, which assumes the input may be unordered and therefore arranges its own buffering/sort to satisfy the `OVER (... ORDER BY x)` clause. When the input is `MonotonicOn(x)` and the access path streams in that order, the buffer/sort is wasted work; the window can run as a streaming pass with bounded state.

Two distinct fast paths:

### Fast path 1 — `LAG/LEAD` over `MonotonicOn`

`LAG(expr, n) OVER (PARTITION BY p ORDER BY x)` retrieves `expr` from the row that's `n` positions earlier in the ordered partition. When the input is `MonotonicOn(x)` and partitioned-aligned with the access plan, the runtime maintains an `n`-deep ring buffer per partition and emits the lagged value as it walks. State is `O(n × P)` where `P` is the active partition count; for typical `n = 1` and a moderate partition count, state is small.

`LEAD(expr, n)` is the symmetric forward case: maintain an `n`-row read-ahead buffer.

The optimizer recognizes window expressions with:
- The window's ordering matches the input's `MonotonicOn` attribute.
- `PARTITION BY` keys, if present, align with the input's grouping or are themselves available without re-sort.
- The window function is `LAG`/`LEAD` (or one of their aliases).

Rewrite: emit a `WindowAdjacent` plan node (or extend the existing window node with a streaming flag) that drives the streaming runtime instead of buffering.

### Fast path 2 — running aggregates over `MonotonicOn`

`SUM(x) OVER (ORDER BY t ROWS UNBOUNDED PRECEDING)` is a running aggregate. When the input is `MonotonicOn(t)` and the frame is `UNBOUNDED PRECEDING [TO CURRENT ROW]`, the aggregate runs as a fold-with-emit per row, with `O(P)` state for `P` active partitions and `O(1)` per row.

The same applies to `COUNT`, `MIN` (with a deque for the windowed minimum), `MAX` (deque), and `AVG` (running sum + count). For `MIN/MAX`, more general window frames require additional bookkeeping; for `UNBOUNDED PRECEDING TO CURRENT ROW` the running state is straightforward.

Recognized shapes (first pass):
- `SUM/COUNT/AVG(...) OVER (PARTITION BY p ORDER BY x ROWS UNBOUNDED PRECEDING)` over `MonotonicOn(x)` aligned with the partition.
- `MIN/MAX(...)` likewise, with the appropriate deque structure.

Frames other than `UNBOUNDED PRECEDING TO CURRENT ROW` are deferred. They're expressible but require sliding-window machinery; out of scope for this ticket.

### Fast path 3 — ranking functions

`ROW_NUMBER() OVER (... ORDER BY x)`, `RANK() OVER (... ORDER BY x)`, `DENSE_RANK() OVER (... ORDER BY x)` over `MonotonicOn(x)` reduce to per-row counter increments. `ROW_NUMBER` is unconditional; `RANK`/`DENSE_RANK` increment on key change. State is `O(P)` for `P` partitions.

This is the cheapest win — single counter per partition, one comparison per row.

### Recognition pattern

The rule operates on the optimizer's window-plan-node (whatever shape Quereus uses today; inspect `planner/nodes/` and the window-functions doc). The pattern:

```
WindowFunction(
  fn: <recognized>,
  partitionBy: [P*],
  orderBy: [{ attr: X, dir: D }],
  frame: <recognized>,
)
over <input>
where input is MonotonicOn(X, D)
  and partitionBy keys align with the input's emit order
  → emit a streaming variant of the window operator
```

"Align with the input's emit order" means either:
- The input is sorted on `(P*, X)` lexicographically (so all rows of one partition appear contiguously in `X` order), or
- `P*` is empty (single global partition).

If neither holds — e.g., the input is `MonotonicOn(X)` globally but partitions are interleaved — the rule doesn't fire; the existing buffered window runs.

### Plan node options

Two reasonable architectures, decided by the implementer after inspecting Quereus's current window machinery:

**Option A — Flag on the existing window node.** Add a `streaming?: boolean` property to the window-plan-node. When true, the emitter dispatches to a streaming runtime; otherwise the existing buffered runtime. The rule sets the flag when preconditions hold. Preserves a single window-node type.

**Option B — Distinct plan node.** Add `StreamingWindow` (or `WindowAdjacent` for `LAG/LEAD` specifically) as a separate node. Keeps the runtime paths in distinct emitters. Maybe duplicates some code, but cleaner cost model.

Option A is probably the right call given Quereus's existing pattern of one node per window invocation; Option B is fine if the runtime divergence is large enough to warrant separation.

### Cost

The streaming variant is asymptotically dominant for any non-trivial input, since the buffered variant is `O(N log N)` for the implicit sort plus `O(N · framewidth)` for evaluation, while the streaming variant is `O(N · framewidth)` only and with much smaller state. The cost model should reflect this so the rule wins reliably when preconditions hold.

### Adapter implications

No new vtab capabilities required beyond `MonotonicOn` advertisement (already in `1-bestaccessplan-monotonic-ordering`). The fast path is purely runtime — it consumes the same `AsyncIterable<Row>` the buffered path would.

### Composition

`MonotonicOn(X)` survives a streaming window invocation when the window only adds new columns without disturbing the row order — i.e., the result remains ordered on `X`. This means downstream rules (`OrdinalSlice`, `MonotonicMerge`, etc.) compose with windowed outputs.

## TODO

### Phase 1: Audit
- Inspect Quereus's current window-function machinery (`planner/nodes/`, `runtime/emit/`, `docs/window-functions.md`). Decide on Option A vs Option B above.
- Catalog which window functions and frames are in scope for the first pass: `LAG`/`LEAD` with `n = 1`, running `SUM`/`COUNT`/`AVG` with `UNBOUNDED PRECEDING TO CURRENT ROW`, ranking functions.

### Phase 2: Recognition rule
- Implement `rule-monotonic-window` in `planner/rules/window/` (create the directory if it doesn't exist).
- Recognition pattern as specified; preconditions on `MonotonicOn` matching the window's `ORDER BY`, partition-emit alignment, recognized function/frame combinations.
- Register in `planner/framework/registry.ts`.

### Phase 3: Streaming runtime
- For each recognized function/frame, implement the streaming emitter logic (ring buffer for `LAG`, read-ahead for `LEAD`, fold for running aggregates, deque for windowed `MIN`/`MAX`, counters for ranking).
- Per-partition state allocation/eviction.

### Phase 4: Tests
- Plan-shape tests confirming the rule fires on each recognized pattern.
- SQL logic tests confirming correct results for each recognized function under streaming vs buffered, with boundary cases (single-row partitions, empty input, NULL handling, partition-boundary correctness for `LAG`/`LEAD`).
- Negative tests confirming the rule doesn't fire for non-monotonic inputs, mis-aligned partitions, or unsupported frames.

### Phase 5: Frame extensions (deferred)
- Sliding window frames (`ROWS BETWEEN n PRECEDING AND CURRENT ROW`, etc.) for running aggregates over monotonic input. Defer to a follow-up ticket; the framework from Phase 3 is the right starting point.
