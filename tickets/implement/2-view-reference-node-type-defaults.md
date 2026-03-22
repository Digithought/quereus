description: Delete dead ViewReferenceNode — never instantiated, all three defects are moot
dependencies: none
files:
  packages/quereus/src/planner/nodes/view-reference-node.ts (deleted)
  packages/quereus/src/planner/building/select.ts (actual view handling, no changes needed)
  packages/quereus/src/planner/type-utils.ts (already handles isReadOnly for views)
----
## Analysis

ViewReferenceNode was dead code:
- Never imported or instantiated anywhere in the codebase
- No emitter registered for it
- Not exported through any barrel/index file

The actual view handling in `select.ts:347-397` inlines the view's SELECT AST via
`buildSelectStmt()`, which correctly inherits column types from underlying tables.
`relationTypeFromTableSchema()` in `type-utils.ts:47` already sets `isReadOnly: true` for views.

All three ticket defects (wrong nodeType, TEXT defaults, isReadOnly=false) existed only in the
dead code path and never affected runtime behavior.

## Resolution

File deleted. Build and all 12 view tests pass. The pre-existing `alterTable` test failure
(emit-missing-types.spec.ts) is unrelated.

## TODO

- Confirm deletion in review (file already removed)
