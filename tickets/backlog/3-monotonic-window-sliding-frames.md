---
description: Streaming fast paths for sliding-frame window functions — ROWS BETWEEN n PRECEDING AND m FOLLOWING, RANGE with offset bounds. Extends the monotonic-window rule and runtime to handle frames that span more than UNBOUNDED PRECEDING TO CURRENT ROW.
prereq: monotonic-window-fast-path
files: packages/quereus/src/planner/rules/window/rule-monotonic-window.ts, packages/quereus/src/runtime/emit/window.ts, packages/quereus/test/logic/07.5-window.sqllogic, docs/window-functions.md
---

## Architecture

The carrier ticket (`monotonic-window-fast-path`) installed a streaming fast path for the cheapest subset of window functions: ranking, navigation, FIRST/LAST_VALUE, and running aggregates over the default frame (`UNBOUNDED PRECEDING TO CURRENT ROW`). Any other frame falls back to the buffered emitter.

This follow-up extends streaming to sliding frames:

| Frame shape | Streaming approach |
| --- | --- |
| `ROWS BETWEEN n PRECEDING AND m FOLLOWING` (literal `n`, `m`) | maintain a sliding ring buffer of size `n + m + 1`; aggregates step on enter, unstep on leave (or recompute from buffer for non-invertible aggregates like MIN/MAX, possibly via a monotonic deque) |
| `RANGE BETWEEN <expr> PRECEDING AND <expr> FOLLOWING` (numeric ORDER BY) | binary search in the order-by buffer to find the value-window bounds |
| `RANGE` with non-numeric ORDER BY | not supported (SQL standard requires numeric for offset RANGE) |

Recognition rule changes: `recognizeFunctionMode` would accept frames matching the sliding shapes when the function class is one of `SUM/COUNT/AVG/MIN/MAX/FIRST_VALUE/LAST_VALUE`. Ranking functions don't take frames.

Runtime: the streaming emitter holds a per-function deque/buffer of the last `n+m+1` row entries (or value-window equivalents). Each row arrival pushes to one end, possibly pops from the other, and the function's slot is finalised when its window is fully visible.

Memory bound: O(n + m + 1) per partition per function. Compared to buffered's O(N) per partition, sliding frames remain a strict win for non-trivial partition sizes.

## Out-of-scope

- DISTINCT aggregates inside sliding frames.
- GROUPS frame mode (peer-group based offsets).
- Frame exclusion clauses (`EXCLUDE CURRENT ROW`, `EXCLUDE GROUP`, `EXCLUDE TIES`).

## TODO

### Phase 1 — Rule extension
- Extend `recognizeFunctionMode` (and the per-function mode discriminated union) with a `slidingAgg` variant carrying the `(precedingRows, followingRows)` literals.
- Validate frame's `start.value` and `end.value` are non-negative integer literals via `tryExtractNumericLiteral`.

### Phase 2 — Runtime
- Add per-function sliding-buffer state (a deque of `{ argValue, rowIndex }` entries).
- Per-arrival logic: push current arg-value, pop entries that fell out of the window's preceding edge.
- For `SUM`/`COUNT`/`AVG`: incremental step+unstep (subtract on pop). For `MIN`/`MAX`: monotonic deque to maintain the running extreme in O(1) amortised. Or fall back to recomputing from the buffer.
- Yield row when its window is fully visible (i.e. when row[i + m] has arrived or partition ends).

### Phase 3 — RANGE offsets
- Maintain a parallel deque of ORDER-BY values; binary search for window bounds when each row arrives.
- Handle NULL ordering values per SQL standard.

### Phase 4 — Tests + docs
- New SQL logic tests in `07.5-window.sqllogic` exercising both ROWS-BETWEEN and RANGE-BETWEEN sliding frames.
- Update `docs/window-functions.md`'s streaming table to cover sliding frames.
