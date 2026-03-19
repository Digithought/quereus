description: weekday N modifier in datetime functions moves in wrong direction
dependencies: none
files:
  packages/quereus/src/func/builtins/datetime.ts
----
## Problem

The `applyWeekdayAdjustment()` function at datetime.ts:266-272 has inverted logic for the SQLite `weekday N` modifier.

SQLite behavior: "weekday N" advances the date **forward** to the next date whose weekday is N (0=Sunday..6=Saturday). If the date is already on that weekday, no change.

Current implementation:
```ts
const daysToAdd = targetISO - dt.dayOfWeek;
if (daysToAdd > 0) return dt.add({ days: daysToAdd - 7 }); // Goes BACKWARD
if (daysToAdd < 0) return dt.add({ days: daysToAdd });       // Goes BACKWARD
```

Example: If today is Monday (ISO 1) and target is Wednesday (ISO 3):
- daysToAdd = 3 - 1 = 2 > 0
- Code does: add(2 - 7) = add(-5) = goes 5 days BACKWARD (to previous Wednesday)
- SQLite would go 2 days FORWARD (to next Wednesday)

## Fix

```ts
function applyWeekdayAdjustment(dt, targetSqlWeekday) {
  const targetISO = targetSqlWeekday === 0 ? 7 : targetSqlWeekday;
  const daysToAdd = ((targetISO - dt.dayOfWeek) + 7) % 7;
  if (daysToAdd > 0) return dt.add({ days: daysToAdd });
  return dt; // Already on target day
}
```

No weekday tests exist currently.

## TODO

- [ ] Fix applyWeekdayAdjustment logic to advance forward
- [ ] Add tests for weekday modifier with various day combinations
