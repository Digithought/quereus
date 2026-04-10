description: Enable foreign_keys pragma by default; make 'ignore' action skip all enforcement
dependencies: none
files:
  - packages/quereus/src/core/database.ts (foreign_keys option registration ~line 250)
  - packages/quereus/src/planner/building/foreign-key-builder.ts (child-side & parent-side FK checks)
  - packages/quereus/src/runtime/foreign-key-actions.ts (cascading action guard)
  - packages/quereus/test/logic/41-foreign-keys.sqllogic
  - packages/quereus/test/logic/41-fk-cross-schema.sqllogic
  - docs/sql.md (§7.6 FOREIGN KEY Constraint)
  - docs/usage.md (options table)
  - docs/memory-table.md (limitations section)
----

## What was changed

Two coordinated changes so that explicit FK action clauses (e.g. `ON DELETE CASCADE`) work out of the box, while the default (no clause) remains non-enforcing:

### 1. `foreign_keys` pragma defaults to `true`

Previously defaulted to `false`, requiring users to `PRAGMA foreign_keys = ON` before any FK enforcement would occur. Now enabled by default.

### 2. `ignore` action means no enforcement

The default FK action when no `ON DELETE` / `ON UPDATE` clause is specified is `ignore` (the internal representation of SQL `NO ACTION`). Previously, `ignore` was treated like `restrict` for parent-side constraint checks. Now `ignore` truly ignores:

- **Parent-side:** `buildParentSideFKChecks` only generates constraint checks for `restrict`, not `ignore`.
- **Child-side:** `buildChildSideFKChecks` skips FKs where both `onDelete` and `onUpdate` are `ignore` — no existence checks are generated.
- **Cascading actions:** Already skipped `ignore` (no change needed in `foreign-key-actions.ts`).

### Net effect

| FK definition | Before (pragma off by default) | After (pragma on, ignore default) |
|---|---|---|
| `REFERENCES t(id)` (no action clause) | No enforcement | No enforcement |
| `REFERENCES t(id) ON DELETE CASCADE` | No enforcement (pragma off) | CASCADE enforced |
| `REFERENCES t(id) ON DELETE RESTRICT` | No enforcement (pragma off) | RESTRICT enforced |

## Testing

All tests in `41-foreign-keys.sqllogic` updated:
- FKs that test enforcement now have explicit `ON DELETE RESTRICT ON UPDATE RESTRICT`
- NO ACTION test updated to verify it means no enforcement (parent delete succeeds, child orphaned)
- Removed trailing `PRAGMA foreign_keys = false` resets (no longer needed)
- Cross-schema test (`41-fk-cross-schema.sqllogic`) already used explicit `ON DELETE RESTRICT` — only removed trailing pragma reset

Full test suite: 1415 passing, 2 pending.

## Docs

Updated `docs/sql.md`, `docs/usage.md`, and `docs/memory-table.md` to reflect:
- Pragma defaults to on
- Default action is IGNORE (informational only)
- Explicit action clauses required for enforcement
