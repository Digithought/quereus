description: Fixed TIME_TYPE.parse to preserve fractional seconds and reject negative numeric input
dependencies: none
files:
  packages/quereus/src/types/temporal-types.ts
  packages/quereus/test/type-system.spec.ts
----
## Summary

`TIME_TYPE.parse` had two bugs when handling numeric input (seconds since midnight):

1. **Fractional seconds lost**: Passing fractional seconds directly to `Temporal.PlainTime` constructor, which only accepts whole integers. `parse(3661.5)` produced `01:01:01` instead of `01:01:01.5`.

2. **Negative input crashes**: Negative values like `-1` produced negative hours via `Math.floor(v / 3600) % 24`, causing `RangeError` from `PlainTime` constructor instead of a clear `TypeError`.

## Fix Applied

- Extract fractional seconds into milliseconds: `Math.round((totalSeconds - wholeSeconds) * 1000)`
- Added upfront validation rejecting negative and non-finite numeric input with a descriptive `TypeError`

## Test Cases

8 new tests added to `type-system.spec.ts` under `TIME_TYPE` describe block:
- Validates ISO time strings
- Parses whole numeric seconds (0, 3661, 86399)
- Preserves fractional seconds (3661.5 → `01:01:01.5`, 0.123 → `00:00:00.123`)
- Rejects negative numeric input with TypeError
- Parses string time values including subsecond
- Returns null for null
- Throws TypeError on non-time strings
- Has isTemporal flag
