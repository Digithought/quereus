description: Fix O(n^2) array/object spread in aggregate step functions — mutate accumulators in-place
dependencies: none
files:
  packages/quereus/src/func/builtins/aggregate.ts
  packages/quereus/src/func/builtins/json.ts
  packages/quereus/test/performance-sentinels.spec.ts
----
## Summary

Three aggregate step functions used spread operators to copy the entire accumulator on every row, resulting in O(n^2) total allocation for n rows. Fixed by mutating the accumulator in-place since aggregate accumulators are per-group and not shared.

### Changes

**group_concat** (aggregate.ts): Changed `initialValue` to a factory function `() => ({ values: [], separator: ',' })` so `cloneInitialValue` creates a fresh nested array per group (shallow clone would share the inner array). Step now uses `acc.values.push()` and direct `acc.separator =` assignment instead of spread.

**json_group_array** (json.ts): Step now uses `acc.push()` instead of `[...acc, value]`. The `cloneInitialValue` shallow array clone is sufficient here since the initial value is a flat `[]`.

**json_group_object** (json.ts): Step now uses `acc[key] = value` instead of `{ ...acc, [key]: value }`. The `cloneInitialValue` shallow object clone is sufficient here since the initial value is a flat `{}`.

**string_concat** (string.ts): Already used `acc.push()` — no change needed.

### Key detail

`cloneInitialValue` (runtime/emit/aggregate.ts:25) does shallow cloning for arrays/objects, and calls factory functions. The `group_concat` case required a factory function because its `initialValue` is `{ values: [], separator: ',' }` — a shallow clone would share the inner `values` array across groups.

### Performance test

Added 3 sentinels in `performance-sentinels.spec.ts` under "Aggregate accumulator spread": `group_concat`, `json_group_array`, and `json_group_object` each over 1000 rows, all under 500ms threshold.

## TODO

- [x] Change group_concat to push onto acc.values directly (with factory initialValue)
- [x] Change json_group_array to push onto acc directly
- [x] Change json_group_object to set property on acc directly
- [x] Add performance sentinel tests for aggregates over large datasets
