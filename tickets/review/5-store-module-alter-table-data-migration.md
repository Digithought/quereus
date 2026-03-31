description: StoreModule.alterTable() with eager row migration for ADD/DROP/RENAME COLUMN
dependencies: none
files:
  - packages/quereus/src/index.ts (exported buildColumnIndexMap, columnDefToSchema)
  - packages/quereus-store/src/common/store-module.ts (StoreModule.alterTable(), buildColumnRemap())
  - packages/quereus-store/src/common/store-table.ts (StoreTable.migrateRows(), updateSchema())
  - packages/quereus-store/test/alter-table.spec.ts (13 tests)
----

## What was built

`StoreModule.alterTable()` implements the `VirtualTableModule.alterTable` interface for store-backed tables, supporting three operations:

- **ADD COLUMN**: Appends new column to schema, migrates all stored rows to include the new value (null or DEFAULT literal). Uses `WriteBatch` for atomic migration.
- **DROP COLUMN**: Removes column from schema, reindexes PK and secondary index definitions, migrates all stored rows to exclude the dropped column slot.
- **RENAME COLUMN**: Schema-only update - renames column in schema and updates index column name references. No row migration needed since positional layout is unchanged.

All operations persist the updated DDL to the catalog store and emit schema change events.

### Key components

- `StoreModule.alterTable()` — orchestrates schema rebuild + row migration + DDL persistence
- `StoreTable.migrateRows(remap, defaultValue)` — iterates all data rows via `buildFullScanBounds()`, applies column remap, writes back via `WriteBatch`
- `StoreTable.updateSchema(newSchema)` — updates the table's in-memory schema reference
- `buildColumnRemap(oldNames, newNames)` — pure utility mapping new column positions to old positions (-1 for new columns)
- `buildColumnIndexMap` and `columnDefToSchema` were exported from `@quereus/quereus` to avoid reimplementation

## Testing

13 tests in `packages/quereus-store/test/alter-table.spec.ts`:

**ADD COLUMN (4 tests)**
- Populated table: existing rows gain null for new column
- DEFAULT value: existing rows receive the specified default
- New inserts after ADD include the new column
- Empty table: schema updates without migration crash

**DROP COLUMN (3 tests)**
- Populated table: rows lose the dropped column, data is consistent
- Empty table: schema updates cleanly
- PK lookups still work after dropping a non-PK column

**RENAME COLUMN (2 tests)**
- Existing data is preserved under the new column name
- New inserts work with the renamed column

**Sequential operations (3 tests)**
- Add, rename, then drop in sequence: all rows remain consistent
- Multiple sequential ADD COLUMN operations
- Add then immediately drop the same column: round-trips cleanly

**DDL persistence (1 test)**
- After ADD COLUMN, `loadAllDDL()` returns DDL reflecting the new schema
