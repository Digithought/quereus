description: Fix NULLS FIRST/LAST ordering reversed when combined with DESC
files:
  - packages/quereus/src/util/comparison.ts
  - packages/quereus/test/utility-edge-cases.spec.ts
  - packages/quereus/test/logic/21-null-edge-cases.sqllogic
  - packages/quereus/test/logic/14-utilities.sqllogic
----

## Summary

Fixed bug where explicit `NULLS FIRST` / `NULLS LAST` was reversed when combined with `DESC` in ORDER BY.

### Root cause

In `compareWithOrderByFast`, the DESC direction negation (`-comparison`) was applied to the entire result
including the NULL-ordering portion. When `NULLS FIRST` set `comparison = -1`, the DESC negation flipped
it to `+1`, effectively making it `NULLS LAST`.

### Fix

When explicit NULLS ordering is specified, the function returns immediately with the correct comparison
value, bypassing the DESC negation. The DESC negation only applies to non-NULL value comparisons and
default NULL ordering.

### Review findings

- Fix is correct and minimal — early returns for explicit NULLS ordering bypass DESC negation cleanly.
- Added missing `DESC NULLS LAST` sqllogic tests to both 14-utilities.sqllogic and 21-null-edge-cases.sqllogic.
- Added unit tests for the `b === null` branch (reversed argument order) with explicit NULLS ordering.
- Fixed misleading comments in `compareWithOrderByFast` that said "nulls last for DESC" — the default
  behavior is actually "nulls first" for both ASC and DESC.
- Fixed matching misleading test name/comment in utility-edge-cases.spec.ts.
- All 1413 tests pass. Build clean.
