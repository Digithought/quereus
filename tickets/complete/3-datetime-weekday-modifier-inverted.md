description: fixed weekday N modifier to advance forward instead of backward
files:
  packages/quereus/src/func/builtins/datetime.ts
  packages/quereus/test/logic/17-weekday-modifier.sqllogic
----
## What was built

The `applyWeekdayAdjustment()` function in `datetime.ts:266-271` had inverted logic
for the SQLite `weekday N` modifier — it moved dates backward instead of forward.
Replaced with standard modular arithmetic: `((targetISO - dt.dayOfWeek) + 7) % 7`.

## Key files

- `packages/quereus/src/func/builtins/datetime.ts` — `applyWeekdayAdjustment()` at line 266
- `packages/quereus/test/logic/17-weekday-modifier.sqllogic` — 18 test cases

## Testing

Test file covers all 7 weekdays from Monday, multiple from Friday, Sunday edge cases,
same-weekday no-change, datetime with time preservation, and combination with `start of day`.
All pass. Build clean.

## Usage

```sql
-- weekday N advances to next occurrence of weekday N (0=Sun..6=Sat)
SELECT date('2024-07-22', 'weekday 3');  -- Monday → Wednesday: 2024-07-24
SELECT date('2024-07-22', 'weekday 1');  -- Monday → Monday (no change): 2024-07-22
```
