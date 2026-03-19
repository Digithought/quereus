description: TIMESPAN multiplication/division fails silently for calendar-unit durations (months, years)
dependencies: none
files:
  packages/quereus/src/runtime/emit/temporal-arithmetic.ts
----
`tryTemporalArithmetic` handles TIMESPAN * NUMBER (and similar) by converting the
duration to total seconds via `duration.total({ unit: 'seconds' })`, multiplying,
and creating a new duration. `Temporal.Duration.total()` without a `relativeTo`
argument throws RangeError for durations containing calendar units (years, months,
weeks). The outer catch returns null.

Example: `CAST('P2M' AS TIMESPAN) * 3` should yield `P6M` but returns null.

For calendar-unit durations, multiplication can be done by scaling the individual
fields (months * N, days * N, etc.) rather than converting to a single unit.

**Severity**: defect

## TODO
- For multiplication: scale individual duration fields directly instead of
  converting to seconds (e.g., `Temporal.Duration.from({ months: d.months * n, days: d.days * n, ... })`)
- For division: similar field-level approach, with consideration for non-integer results
- Add tests: `CAST('P2M' AS TIMESPAN) * 3`, `CAST('P1Y6M' AS TIMESPAN) / 2`
