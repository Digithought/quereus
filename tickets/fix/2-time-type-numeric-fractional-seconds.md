description: TIME_TYPE.parse loses fractional seconds when converting from numeric input
dependencies: none
files:
  packages/quereus/src/types/temporal-types.ts
----
## Problem

`TIME_TYPE.parse` for numeric input (seconds since midnight) passes fractional seconds directly to `Temporal.PlainTime` constructor, which truncates them. For example, input `3661.5` (1 hour, 1 minute, 1.5 seconds) produces `01:01:01` instead of `01:01:01.5`.

The `PlainTime` constructor accepts `(hour, minute, second, millisecond, microsecond, nanosecond)` — it does not accept fractional seconds in the `second` argument.

Additionally, negative numeric input (e.g., -1) produces negative hours via `Math.floor(v / 3600) % 24`, which throws `RangeError` from `PlainTime` constructor.

## Expected Behavior

- `TIME_TYPE.parse(3661.5)` should return `'01:01:01.5'`
- `TIME_TYPE.parse(-1)` should either wrap around (23:59:59) or throw a clear TypeError

## Fix

Extract fractional seconds into milliseconds:
```typescript
const totalSeconds = v % 60;
const wholeSeconds = Math.floor(totalSeconds);
const milliseconds = Math.round((totalSeconds - wholeSeconds) * 1000);
const time = new Temporal.PlainTime(hours, minutes, wholeSeconds, milliseconds);
```

For negative input, add validation or modular wrapping before constructing.

- [ ] Fix fractional seconds extraction in TIME_TYPE.parse numeric path
- [ ] Handle negative numeric input gracefully
- [ ] Add tests for fractional and negative numeric TIME input
