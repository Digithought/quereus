description: O(n^2) array/object spread in aggregate step functions
dependencies: none
files:
  packages/quereus/src/func/builtins/aggregate.ts
  packages/quereus/src/func/builtins/json.ts
  packages/quereus/src/func/builtins/string.ts
----
## Problem

Several aggregate functions create new arrays/objects on every step call using spread operators, resulting in O(n^2) total memory allocation for n rows:

1. **group_concat** (aggregate.ts:164): `{ values: [...acc.values, strValue], separator: currentSeparator }` - copies entire array each step
2. **json_group_array** (json.ts:443): `return [...acc, preparedValue]` - copies entire array each step
3. **json_group_object** (json.ts:458): `return { ...acc, [stringKey]: preparedValue }` - copies entire object each step
4. **string_concat** (string.ts:258): Uses `acc.push(value)` which is fine (mutates), but the pattern is inconsistent

For large datasets this is a significant performance bottleneck.

## Fix

Mutate the accumulator in-place (push for arrays, direct property set for objects) rather than creating copies via spread. Aggregate accumulators are not shared state - they are per-group and owned by the aggregate function. The comment in group_concat says "Create a new array instead of mutating the existing one" but this is unnecessary for aggregate state.

## TODO

- [ ] Change group_concat to push onto acc.values directly
- [ ] Change json_group_array to push onto acc directly
- [ ] Change json_group_object to set property on acc directly
- [ ] Add a performance note/test for aggregates over large datasets
