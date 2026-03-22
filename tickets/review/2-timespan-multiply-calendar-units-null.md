description: Fix TIMESPAN multiplication/division for calendar-unit durations (months, years, weeks)
dependencies: none
files:
  packages/quereus/src/runtime/emit/temporal-arithmetic.ts
  packages/quereus/test/logic/15-timespan.sqllogic
----

## Problem
`tryTemporalArithmetic` converted durations to total seconds via `duration.total({ unit: 'seconds' })`
before multiplying/dividing. `Temporal.Duration.total()` throws `RangeError` for durations containing
calendar units (years, months, weeks) — these have variable lengths without a `relativeTo` reference.
The outer catch returned `null`, silently swallowing the error.

Example: `timespan('P2M') * 3` returned `null` instead of `P6M`.

## Fix
- **Multiplication** (`TIMESPAN * NUMBER`, `NUMBER * TIMESPAN`): When the duration has calendar units,
  scale each individual field directly via `scaleDuration()` instead of converting to seconds.
- **Division** (`TIMESPAN / NUMBER`): When the duration has calendar units, use `divideDuration()`
  which cascades integer remainders from larger to smaller units
  (years→months×12, weeks→days×7, days→hours×24, etc.).
  Months cannot cascade to days (variable month length), so sub-month remainders are truncated.
- **Ratio** (`TIMESPAN / TIMESPAN`): Returns `null` when either operand has calendar units,
  since numeric ratios are undefined without a reference date.

## Key helpers added
- `hasCalendarUnits(d)` — checks for years/months/weeks fields
- `scaleDuration(d, factor)` — multiplies each duration field by factor
- `divideDuration(d, divisor)` — integer division with remainder cascading

## Tests for validation
- `timespan('P2M') * 3` → `P6M`
- `timespan('P1Y6M') * 2` → `P2Y12M`
- `4 * timespan('P3M')` → `P12M`
- `timespan('P1Y6M') / 2` → `P9M`
- `timespan('P6M') / 3` → `P2M`
- `timespan('P1Y2M3DT4H') * 2` → `P2Y4M6DT8H`
- `timespan('P2Y4M6DT8H') / 2` → `P1Y2M3DT4H`
- All existing time-unit multiplication/division tests continue to pass
