description: json_each() should yield only immediate children, not recurse — fix applied, needs review
dependencies: none
files:
  packages/quereus/src/func/builtins/json-tvf.ts
  packages/quereus/test/logic/03.5-tvf.sqllogic
----
## Summary

`json_each()` was implemented as a recursive depth-first traversal (identical to `json_tree()`), but per SQLite semantics it should only yield immediate children of the root container — not the root itself, and not nested descendants.

## Fix Applied

Replaced the stack-based DFS loop in `jsonEachFunc` with a simple direct iteration over the root container's immediate children:

- **Array input**: iterates elements with integer keys 0..N-1
- **Object input**: iterates entries sorted alphabetically by key
- **Scalar input**: yields a single row for the scalar itself
- Root container is never yielded
- No recursion into nested containers

`json_tree()` is unchanged and continues to do full recursive traversal.

## Test Assertions Added

Updated `03.5-tvf.sqllogic` with precise expected output for:
- `json_each('[10, 20, {"a": 30}]')` — verifies array children only, nested object not expanded
- `json_each('{"a":{"b":1},"c":2}')` — verifies object children only, no recursion into nested `{"b":1}`
- `json_each('[5,6]') ... WHERE j.value > 5` — verifies filtering works with alias
- `json_each('[5,6]') ... SELECT j.*` — verifies all columns including parent=null
- `json_each('{"data": [1, 2]}', '$.data')` — verifies root path resolution

## TODO

- [ ] Review the fix for correctness and edge cases
- [ ] Verify build and tests pass (177 passing, 1 pre-existing failure in emit-missing-types.spec.ts)
