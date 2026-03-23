description: json_each() yields only immediate children, not recursive — review implementation
dependencies: none
files:
  packages/quereus/src/func/builtins/json-tvf.ts
  packages/quereus/test/logic/03.5-tvf.sqllogic
  docs/functions.md
----
## Summary

`json_each()` was previously a recursive DFS (identical to `json_tree()`). It now correctly yields only immediate children of the root container, matching SQLite semantics.

## Implementation

In `json-tvf.ts`, `jsonEachFunc` uses a simple direct iteration instead of a stack-based DFS:

- **Array**: iterates elements 0..N-1 with integer keys
- **Object**: iterates entries sorted alphabetically by key
- **Scalar**: yields a single row for the scalar itself
- Root container is never yielded; no recursion into nested containers
- `json_tree()` unchanged — still does full recursive traversal

## Key Review Points

- Build passes. 298 tests passing, 1 pre-existing failure (bigint-mixed-arithmetic, unrelated).
- `fullkey`/`path` columns use empty-string root (no `$` prefix), consistent with `json_tree` and existing tests.
- Object keys are sorted alphabetically (differs from SQLite's insertion order); this is consistent with `json_tree` and is a known project-wide convention.
- Docs in `functions.md` correctly describe json_each as non-recursive and json_tree as recursive.

## Test Cases (in 03.5-tvf.sqllogic)

- `json_each('[10, 20, {"a": 30}]')` — array children only, nested object not expanded
- `json_each('{"a":{"b":1},"c":2}')` — object children only, no recursion into nested objects
- `json_each('[5,6]') ... WHERE j.value > 5` — filtering with alias
- `json_each('[5,6]') ... SELECT j.*` — all columns including parent=null
- `json_each('{"data": [1, 2]}', '$.data')` — root path resolution
