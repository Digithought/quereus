---
description: DROP INDEX on a `USING store` table updates the engine-side schema registry (via `SchemaManager.dropIndex`) but leaves the connected `StoreTable`'s cached `tableSchema` stale, because `StoreModule` does not implement `dropIndex`. Subsequent INSERT/UPDATE on the same connection continues to maintain entries in the now-dropped index store and (for UNIQUE indexes) keeps enforcing the synthesized `uniqueConstraints` entry — symmetric counterpart to the create-side fix in `store-table-create-index-schema-not-updated` and the engine-side drop fix in `schema-manager-drop-index-stale-unique-constraint`.
files:
  packages/quereus-store/src/common/store-module.ts
  packages/quereus-store/src/common/store-table.ts
  packages/quereus/src/schema/manager.ts
---

## Problem

`SchemaManager.dropIndex` (`packages/quereus/src/schema/manager.ts:1277`)
only invokes the module's `dropIndex` hook if one is registered:

```ts
if (moduleReg?.module?.dropIndex) {
    await moduleReg.module.dropIndex(this.db, schemaName, ownerTable.name, indexName);
}
```

`StoreModule` does not export a `dropIndex` method. The engine schema
registry still gets the updated `TableSchema` (without the index and
without the derived `uniqueConstraints` entry tagged by
`derivedFromIndex`), but the `StoreTable` instance holds its own
`tableSchema` reference captured at connect time. Its DML helpers
(`updateSecondaryIndexes`, `checkUniqueConstraints`,
`uniqueColumnsChanged`) read off `this.tableSchema`, so on that
connection:

- INSERT/UPDATE keeps writing entries to the index store that the
  engine no longer knows about
- `checkUniqueConstraints` keeps enforcing the synthesized
  `UniqueConstraintSchema` that was tagged with `derivedFromIndex`

This is the exact mirror of the create-side bug fixed by
`store-table-create-index-schema-not-updated`. The fix in
`schema-manager-drop-index-stale-unique-constraint` already added the
`derivedFromIndex` tag at store-side create time
(`packages/quereus-store/src/common/store-module.ts:343-356`) and left
a comment pointing here so the eventual `dropIndex` implementation
only needs to mirror `SchemaManager.dropIndex` / `MemoryTableManager.dropIndex`.

## Expected behavior

After `DROP INDEX ix ON store_table`:

- The underlying `IndexStore` is released / cleaned up by the
  `IndexStoreProvider`
- The connected `StoreTable.tableSchema` is refreshed via
  `table.updateSchema(updatedSchema)`, mirroring `createIndex`:
  - `indexes` filtered to remove the dropped index
  - `uniqueConstraints` filtered by `derivedFromIndex?.toLowerCase() !==
    indexName.toLowerCase()`, collapsing to `undefined` when empty
- A `schemaChange` event is emitted (`type: 'drop', objectType: 'index'`)

The implementation should mirror `StoreModule.createIndex`
(`packages/quereus-store/src/common/store-module.ts:308-367`) point-for-point.

## Use cases

- `create table t (...) using store;` then `create unique index ix on
  t(col);` then `drop index ix;` then `insert into t(col) values (X);
  insert into t(col) values (X);` — second insert should succeed
  (currently rejected by the stale derived UNIQUE constraint cached on
  the StoreTable).
- Non-UNIQUE index drop on a store-backed table — INSERTs should stop
  maintaining the dropped index store's entries.

## Test coverage to add

- A `.sqllogic` file mirroring
  `packages/quereus/test/logic/drop-unique-index.sqllogic` but run against
  the store path (it is picked up automatically by `yarn test:store`).
- A `quereus-store` unit test verifying that
  `StoreModule.dropIndex` releases the `IndexStore`, refreshes the
  `StoreTable` cached schema, and emits the schema-change event.

## Related

- `store-table-create-index-schema-not-updated` (complete) — create-side
  symmetric fix.
- `schema-manager-drop-index-stale-unique-constraint` (complete) —
  engine + memory-vtab drop-side fix that introduced the
  `derivedFromIndex` tag this work will rely on.
