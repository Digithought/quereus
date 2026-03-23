description: Deleted dead ViewReferenceNode — never instantiated, all three original defects were moot
dependencies: none
files:
  packages/quereus/src/planner/nodes/view-reference-node.ts (deleted)
  packages/quereus/src/planner/building/select.ts (actual view handling, unchanged)
  packages/quereus/src/planner/type-utils.ts (already handles isReadOnly for views)
----
## Summary

ViewReferenceNode was dead code — never imported, instantiated, emitted, or exported. The three
original defects (wrong nodeType, TEXT defaults, isReadOnly=false) existed only in the dead code
path and never affected runtime behavior.

The actual view handling in `select.ts` inlines the view's SELECT AST via `buildSelectStmt()`,
which correctly inherits column types from underlying tables. `relationTypeFromTableSchema()` in
`type-utils.ts` already sets `isReadOnly: true` for views.

## What changed

- Deleted `packages/quereus/src/planner/nodes/view-reference-node.ts`

## Testing notes

- Build passes
- All 329 tests pass (1 pre-existing failure in `10.1-ddl-lifecycle.sqllogic` unrelated to views)
- View tests (`08-views.sqllogic`) pass
- No references to `ViewReferenceNode` or `view-reference-node` remain in the codebase

## Review checklist

- Confirm no remaining imports or references to the deleted file
- Confirm view queries still function correctly (types, isReadOnly)
- Verify `select.ts` view handling is the sole and correct code path
