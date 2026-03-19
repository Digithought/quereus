description: Fix pre-existing test failure in keys-propagation.spec.ts — String() on JSON objects
dependencies: none
files:
  packages/quereus/test/optimizer/keys-propagation.spec.ts
----
The test "Join combines keys for inner join (conservative)" fails because `String(rows[0].props)` produces `[object Object],[object Object],...` instead of a JSON string.

`json_group_array(properties)` returns a value where `properties` are already parsed objects. Using `String()` on an array of objects doesn't produce JSON — it should use `JSON.stringify()` instead.

The same `String(rows[0].props)` pattern is used in multiple tests in this file. The other tests happen to pass because their `properties` values stringify differently, but the pattern is fragile throughout.

## TODO

- Replace `String(rows[0].props as unknown as string)` with `JSON.stringify(rows[0].props)` in the failing test (line 37)
- Audit all similar `String(...)` calls in the same file and fix them for consistency
- Verify all 7 tests pass after the fix
