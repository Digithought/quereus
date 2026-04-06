description: Fix NULLS FIRST/LAST ordering reversed when combined with DESC
dependencies: none
files:
  - packages/quereus/src/util/comparison.ts (compareWithOrderByFast, lines ~291-309)
  - packages/quereus/test/utility-edge-cases.spec.ts (lines ~455-465)
  - packages/quereus/test/logic/21-null-edge-cases.sqllogic (line 57)
  - packages/quereus/test/logic/14-utilities.sqllogic (line 37)
----

## Summary

Fixed bug where explicit `NULLS FIRST` / `NULLS LAST` ordering was reversed when combined with `DESC`.

### Root cause

In `compareWithOrderByFast`, the DESC direction negation (`-comparison`) on line 313 was applied to the
entire comparison result, including the NULL-ordering portion. When `NULLS FIRST` set `comparison = -1`,
the DESC negation flipped it to `+1`, effectively making it `NULLS LAST`.

### Fix

When explicit NULLS ordering is specified (`FIRST` or `LAST`), the function now returns immediately with
the correct comparison value, bypassing the DESC negation. The DESC negation only applies to:
- Non-NULL value comparisons
- Default NULL ordering (where the direction-dependent default is already baked in)

### Key test cases

- `ORDER BY col DESC NULLS FIRST` -- NULLs should appear before non-NULL values
- `ORDER BY col DESC NULLS LAST` -- NULLs should appear after non-NULL values
- `ORDER BY col ASC NULLS FIRST` -- NULLs should appear before non-NULL values (unchanged)
- `ORDER BY col ASC NULLS LAST` -- NULLs should appear after non-NULL values (unchanged)
- Default behavior (no explicit NULLS) -- unchanged (nulls first for ASC, nulls last for DESC)
