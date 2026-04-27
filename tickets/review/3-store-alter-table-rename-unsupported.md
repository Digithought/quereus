description: StoreModule now implements ALTER TABLE ... RENAME TO — module-level rename hook promoted to VirtualTableModule, physical storage relocation delegated to provider, persistent catalog rewritten under the new name
prereq: none
files:
  packages/quereus/src/vtab/module.ts
  packages/quereus/src/vtab/memory/module.ts
  packages/quereus/src/runtime/emit/alter-table.ts
  packages/quereus-store/src/common/kv-store.ts
  packages/quereus-store/src/common/store-module.ts
  packages/quereus-plugin-leveldb/src/provider.ts
  packages/quereus-store/test/alter-table.spec.ts
----

### What changed

- `VirtualTableModule` gained an optional `renameTable(db, schemaName, oldName, newName): Promise<void>` hook. `MemoryTableModule.renameTable` was updated to match the new async signature.
- `runRenameTable` in `packages/quereus/src/runtime/emit/alter-table.ts` now delegates to `module.renameTable` (if present) *before* the in-memory schema catalog is mutated. The old `instanceof MemoryTableModule` special-case is gone.
- `KVStoreProvider` gained an optional `renameTableStores(schemaName, oldName, newName)`. The LevelDB provider implements it: closes open handles for the data store and every `{oldName}_idx_*` store, then `fs.rename`s the directories under `{basePath}/{schema}/`. An in-memory test provider in `alter-table.spec.ts` implements the same semantics.
- `StoreModule.renameTable` is the main new piece. It:
  1. Flushes any pending transaction ops on the old table's coordinator before the physical move, since renaming a directory is not reversible (treated as DDL-committing, consistent with DROP TABLE).
  2. Disconnects the cached `StoreTable` handle (flushes lazy stats).
  3. Drops the `tables`/`stores`/`coordinators` entries keyed by the old name.
  4. Delegates to `provider.renameTableStores`.
  5. Writes the new catalog DDL, then deletes the old catalog entry (new-first ordering so a crash mid-rename leaves the table discoverable under at least one name).
  6. Removes the stale `__stats__` entry keyed by the old name.
  7. Emits an `alter`/`table` schema-change event.

  After this returns, the next access to the new name goes through `connect()` which creates a fresh `StoreTable` over the renamed directories.

### Use cases to validate

- `alter table t RENAME to u` on a populated store-backed table: subsequent `select * from u` returns all original rows (the original defect in 41-alter-table.sqllogic:104).
- Inserts after rename under the new name persist and show up in both the same session and across reconnects.
- The old name is no longer resolvable (`select * from t_rename` → error).
- Rename to an existing table errors with "already exists".
- Persisted catalog DDL is rewritten: `loadAllDDL()` returns the DDL under the new name and drops the old key.
- Stats store no longer carries the old `{schema}.{oldName}` key.

Five new unit tests in `packages/quereus-store/test/alter-table.spec.ts` cover these cases against an in-memory provider that implements `renameTableStores`.

### Test status

- `yarn test` — all 2443 quereus tests + 121 workspace tests pass.
- `yarn workspace @quereus/store test` — all 175 tests pass (including the 5 new RENAME TABLE cases).
- `yarn test:store` — advances past the original 41-alter-table.sqllogic:104 rename failure. Store-mode now runs deeper in that file and hits a **pre-existing, unrelated** failure in section 5 (ADD COLUMN `required text` should error with NOT NULL, but succeeds). That's a separate discrepancy between `StoreModule.alterTable` (hard-codes `defaultNotNull=false`) and `MemoryTableLayerManager.addColumn` (reads `db.options.default_column_nullability`). Filed as a follow-up fix ticket.

### Review checklist

- VirtualTableModule.renameTable contract is optional and documented — modules that don't persist by table name can ignore it.
- Memory-module behavior is unchanged aside from the async signature.
- LevelDB provider cleans up index directories even for indexes that were never opened in the current session (pre-existing sweep pattern used by `deleteTableStores`).
- StoreModule.renameTable is idempotent-safe against missing tables (optional chaining on `existing`) and handles the in-transaction case by flushing.
- Catalog rewrite writes the new DDL before deleting the old key, matching the pattern in `removeTableDDL`/`saveTableDDL`.
- The stale `StoreConnection` registered with the database is not explicitly unregistered — relying on the fact that the coordinator's state is cleared after the DDL-committing flush, so its `commit()` at outer-tx end is a no-op.
