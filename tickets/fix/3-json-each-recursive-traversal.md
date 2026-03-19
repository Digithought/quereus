description: json_each() recursively traverses nested structures instead of yielding only immediate children
dependencies: none
files:
  packages/quereus/src/func/builtins/json-tvf.ts
  packages/quereus/test/logic/03.5-tvf.sqllogic
----
## Problem

`json_each()` is implemented as a recursive depth-first traversal (identical behavior to `json_tree()`), but per SQLite semantics it should only yield the **immediate children** of the top-level container.

For example, `json_each('{"a":{"b":1},"c":2}')` currently yields:
- Root object (key=null)
- "a": {"b":1}
- "b": 1 (child of "a" - should NOT be yielded)
- "c": 2

SQLite would yield only:
- "a": {"b":1}
- "c": 2

The root itself should also not be yielded - only its children.

The existing tests say "just test it runs for now" without asserting exact output, so this behavior is untested.

## Fix

In `jsonEachFunc` (json-tvf.ts), after yielding the root container's row, push only its immediate children onto the stack but do NOT recurse into their children. The simplest approach: remove the child-pushing logic from the main loop body and instead enumerate children of the start node directly (without pushing container children further).

## TODO

- [ ] Fix jsonEachFunc to only yield immediate children of the root container
- [ ] Do not yield the root container itself (only its children)
- [ ] Add precise assertions to json_each tests in 03.5-tvf.sqllogic
- [ ] Verify json_tree still works correctly (should be unaffected)
