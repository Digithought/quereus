description: json_each() yields only immediate children, not recursive — completed
files:
  packages/quereus/src/func/builtins/json-tvf.ts
  packages/quereus/test/logic/03.5-tvf.sqllogic
  docs/functions.md
----
## What was built

`json_each()` was corrected to yield only immediate children of the root container, matching SQLite semantics. Previously it performed a recursive DFS identical to `json_tree()`.

- **Array input**: iterates elements 0..N-1 with integer keys
- **Object input**: iterates entries sorted alphabetically by key
- **Scalar input**: yields a single row for the scalar itself
- Root container is never yielded; no recursion into nested containers
- `json_tree()` unchanged — still does full recursive DFS

## Testing

All 1,761 tests pass. Key test cases in `03.5-tvf.sqllogic`:
- `json_each('[10, 20, {"a": 30}]')` — array children only, nested object not expanded
- `json_each('{"a":{"b":1},"c":2}')` — object children only, no recursion
- `json_each('[5,6]') ... WHERE j.value > 5` — filtering with alias
- `json_each('[5,6]') ... SELECT j.*` — all columns including parent=null
- `json_each('{"data": [1, 2]}', '$.data')` — root path resolution
- Error cases: invalid JSON, incorrect argument count

## Notes

- Object keys sorted alphabetically (differs from SQLite insertion order); consistent project-wide convention
- `fullkey`/`path` use empty-string root (no `$` prefix), consistent with `json_tree`
- Column schema duplicated between `jsonEachFunc` and `jsonTreeFunc` — pre-existing, minor DRY opportunity
