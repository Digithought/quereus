description: fixed weekday N modifier to advance forward instead of backward
dependencies: none
files:
  packages/quereus/src/func/builtins/datetime.ts
  packages/quereus/test/logic/17-weekday-modifier.sqllogic
----
## Summary

The `applyWeekdayAdjustment()` function in `datetime.ts:266-272` had inverted logic
for the SQLite `weekday N` modifier. It moved dates **backward** to the previous
matching weekday instead of **forward** to the next one.

## Fix

Replaced the branching subtraction logic with modular arithmetic:

```ts
const daysToAdd = ((targetISO - dt.dayOfWeek) + 7) % 7;
if (daysToAdd > 0) return dt.add({ days: daysToAdd });
return dt; // Already on target day
```

This correctly advances forward (or stays put if already on the target day),
matching SQLite's documented behavior.

## Testing

New test file `17-weekday-modifier.sqllogic` covers:
- All 7 weekdays from a Monday starting point (2024-07-22)
- Multiple weekdays from a Friday starting point (2024-07-26)
- Sunday (weekday 0) edge cases from a Sunday starting point (2024-07-28)
- Same-weekday no-change case for each starting day
- Weekday modifier with `datetime()` (preserves time component)
- Weekday modifier combined with `start of day`

All 929 tests pass, build is clean.
