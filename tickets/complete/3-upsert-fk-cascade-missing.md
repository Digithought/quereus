description: UPSERT DO UPDATE and INSERT OR REPLACE now execute FK cascading actions
files:
  packages/quereus/src/runtime/emit/dml-executor.ts
  packages/quereus/src/runtime/foreign-key-actions.ts
  packages/quereus/test/logic/41-foreign-keys.sqllogic
----

## What was built

Two missing `executeForeignKeyActions` calls were added in `dml-executor.ts`:

1. **UPSERT DO UPDATE** (line ~321): FK cascading actions now fire when INSERT ON CONFLICT DO UPDATE resolves to the update path. Passes `existingRow` as old and `updatedRow` as new, matching the regular UPDATE path.

2. **INSERT OR REPLACE** (line ~368): FK cascading actions now fire as a `'delete'` operation on the replaced row, since REPLACE is semantically delete+insert.

Both call sites are consistent with the existing UPDATE (line 458) and DELETE (line 540) canonical paths.

## Testing

Tests in `41-foreign-keys.sqllogic` cover:
- UPSERT DO UPDATE + ON UPDATE CASCADE (parent PK change cascades to child)
- UPSERT DO UPDATE + ON UPDATE SET NULL (parent PK change nullifies child FK)
- INSERT OR REPLACE + ON DELETE CASCADE (replaced parent row cascades delete to children)
- INSERT OR REPLACE + ON DELETE SET NULL (replaced parent row nullifies child FK)

329/330 tests pass. 1 pre-existing failure in `10.1-ddl-lifecycle.sqllogic` (alterTable stringification, unrelated).

## Usage

With `PRAGMA foreign_keys = true`:
- `INSERT INTO parent (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET id = 2` — triggers ON UPDATE CASCADE/SET NULL/SET DEFAULT on child tables
- `INSERT OR REPLACE INTO parent VALUES (1, 'new')` — triggers ON DELETE CASCADE/SET NULL/SET DEFAULT on child tables referencing the replaced row
