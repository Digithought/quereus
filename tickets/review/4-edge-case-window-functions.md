description: Edge-case sqllogic tests for window function subsystem + ROWS frame bounds fix
dependencies: none
files:
  packages/quereus/test/logic/27-window-edge-cases.sqllogic
  packages/quereus/src/runtime/emit/window.ts
----

## What was built

**New test file**: `test/logic/27-window-edge-cases.sqllogic` — 10 edge-case categories:

1. **Zero-width frame** (`ROWS BETWEEN 0 PRECEDING AND 0 FOLLOWING`) — confirms only current row in frame
2. **Frame excluding current row** (`ROWS BETWEEN 1 PRECEDING AND 1 PRECEDING`, `1 FOLLOWING AND 1 FOLLOWING`) — verifies NULL when frame is out of bounds at partition edges
3. **Empty partition** — WHERE filter yields no rows for a partition key, no phantom partition
4. **Single-row partition** — all window functions on one row: row_number=1, rank=1, lag/lead=NULL, percent_rank=0, cume_dist=1
5. **Mixed ASC/DESC ORDER BY** — composite ordering with row_number, running sum, lag/lead
6. **Large LAG/LEAD offsets** — offset=100 on 3-5 row partitions, with and without default values
7. **RANGE with peers** — `RANGE BETWEEN CURRENT ROW AND CURRENT ROW` includes all peer rows; contrasted with ROWS equivalent
8. **Window over zero rows** — `WHERE 1=0` with row_number, sum, count, rank; returns empty result
9. **Multiple different window definitions** — single query with different PARTITION BY, ORDER BY, and function types
10. **Window + aggregate composition** — window function in subquery consumed by outer aggregate (sum, avg, max)

## Bug fix

Fixed ROWS-mode frame bounds in `getFrameBounds()` (`window.ts:529`). The prior code clamped start/end with `Math.max(0, ...)`/`Math.min(totalRows-1, ...)` *during* computation, which masked logically empty frames. For example, `ROWS BETWEEN 1 PRECEDING AND 1 PRECEDING` at the first row would clamp both bounds to 0, incorrectly including the current row instead of producing an empty frame.

**Fix**: compute raw (unclamped) offsets for ROWS mode, then clamp *after* both bounds are known. The existing `start > end` empty-frame check then correctly detects frames entirely outside the valid range.

## Testing notes

- All 1697 tests pass (including new + existing window tests)
- No lint regressions in changed files
- Key validation: test #2 (frame excluding current row) directly exercises the bug fix — `sum()` returns NULL for the first/last row where the frame is out of bounds
- The engine requires ORDER BY for ranking functions (row_number, rank, etc.), so the zero-rows test uses `ORDER BY id` rather than bare `OVER ()`
