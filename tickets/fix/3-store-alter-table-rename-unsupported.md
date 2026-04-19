description: ALTER TABLE ... RENAME TO silently does not update StoreModule internal state or physical storage paths, so subsequent queries against the new name return 0 rows
dependencies: none
files:
  packages/quereus/src/runtime/emit/alter-table.ts
  packages/quereus-store/src/common/store-module.ts
  packages/quereus-plugin-leveldb/src/provider.ts
  packages/quereus/test/logic/41-alter-table.sqllogic
----

Under `QUEREUS_TEST_STORE=true`, `41-alter-table.sqllogic:104` returns an empty result set where 2 rows are expected:

```
create table t_rename (id integer primary key, val text);
insert into t_rename values (1, 'a'), (2, 'b');
alter table t_rename rename to t_renamed;
select * from t_renamed order by id;
-- expected: 2 rows; actual: 0 rows
```

### Cause

`runRenameTable` in `packages/quereus/src/runtime/emit/alter-table.ts:60-100` only propagates rename to `MemoryTableModule`:

```
if (module instanceof MemoryTableModule) {
   module.renameTable(tableSchema.schemaName, oldName, newName);
}
```

For `StoreModule`, no equivalent call exists. After rename:

- Catalog/schema lists the table under `t_renamed`, but the StoreModule's `this.tables` / `this.stores` maps still key it by `t_rename`.
- The provider's on-disk store is at `.../main/t_rename/...`; no directory at `.../main/t_renamed/...`.
- A query on `t_renamed` takes the `connect()` path, looks up schemaManager (finds the renamed schema), creates a fresh StoreTable, eagerly opens a brand-new empty LevelDB at `.../main/t_renamed/...` (`createIfMissing: true`). Reads yield 0 rows.
- The catalog row for the old DDL is still keyed by `t_rename`. On rehydrate, the table would reappear under its old name.

### Fix direction

Replace the `instanceof MemoryTableModule` special-case with a generic module-level `renameTable` contract on `VirtualTableModule`, and implement it in `StoreModule`. For the store module, rename must:

1. Close and rename (or re-key) the provider's data store, index stores, and any cached handles from the old tableKey to the new one.
2. Move on-disk directories: `{basePath}/{schema}/{oldName}` → `{basePath}/{schema}/{newName}`, plus each `{oldName}_idx_{index}` sibling.
3. Re-key `StoreModule.tables`, `StoreModule.stores`, `StoreModule.coordinators`.
4. Update the catalog entry: delete the old `buildCatalogKey(schema, oldName)` DDL row and save a fresh DDL under the new key.
5. Update any open `StoreTable.tableName` bookkeeping (the VirtualTable base class holds the original name; it may need a rename hook too).

### TODO

- Decide whether to promote `renameTable` to a formal optional method on `VirtualTableModule` (then delete the `instanceof` check in alter-table.ts), or keep it duck-typed.
- Implement physical-storage rename in `LevelDBProvider` (close affected stores, `fs.rename` directories, drop old entries from internal maps).
- Implement `StoreModule.renameTable`.
- Rewrite `runRenameTable` to delegate to whichever module hook is available.
- Add a reproducing test under `packages/quereus-store/test/` once the fix is in place.
- Re-run `41-alter-table.sqllogic` under `yarn test:store`.
