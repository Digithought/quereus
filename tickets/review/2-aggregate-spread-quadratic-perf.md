description: Fix O(n^2) array/object spread in aggregate step functions — mutate accumulators in-place
files:
  packages/quereus/src/func/builtins/aggregate.ts
  packages/quereus/src/func/builtins/json.ts
  packages/quereus/src/runtime/emit/aggregate.ts
  packages/quereus/test/performance-sentinels.spec.ts
----
## Summary

Three aggregate step functions previously used spread operators to copy the entire accumulator on every row, resulting in O(n^2) total allocation for n rows. Fixed by mutating the accumulator in-place since aggregate accumulators are per-group and not shared.

### Changes

**group_concat** (aggregate.ts): `initialValue` is a factory function `() => ({ values: [], separator: ',' })` so `cloneInitialValue` creates a fresh nested array per group (shallow clone would share the inner array). Step uses `acc.values.push()` and direct `acc.separator =` assignment instead of spread.

**json_group_array** (json.ts): Step uses `acc.push()` instead of `[...acc, value]`. The `cloneInitialValue` shallow array clone is sufficient since the initial value is a flat `[]`.

**json_group_object** (json.ts): Step uses `acc[key] = value` instead of `{ ...acc, [key]: value }`. The `cloneInitialValue` shallow object clone is sufficient since the initial value is a flat `{}`.

### Key detail

`cloneInitialValue` (runtime/emit/aggregate.ts:25) does shallow cloning for arrays/objects, and calls factory functions. The `group_concat` case required a factory function because its `initialValue` is `{ values: [], separator: ',' }` — a shallow clone would share the inner `values` array across groups.

## Testing

Performance sentinel tests in `performance-sentinels.spec.ts` under "Aggregate accumulator spread":
- `group_concat` over 1000 rows — under 500ms threshold
- `json_group_array` over 1000 rows — under 500ms threshold
- `json_group_object` over 1000 rows — under 500ms threshold

All 3 sentinels pass (~292ms total). Sqllogic tests for aggregates and builtin functions also pass.

## Use cases for validation

- `group_concat(col, ',')` on large result sets should be O(n) not O(n^2)
- `json_group_array(col)` on large result sets should be O(n) not O(n^2)
- `json_group_object(key, val)` on large result sets should be O(n) not O(n^2)
- Multiple groups (GROUP BY) should each get independent accumulators (factory fn / cloneInitialValue)
