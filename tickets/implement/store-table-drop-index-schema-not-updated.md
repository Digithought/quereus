---
description: Implement `StoreModule.dropIndex` so that DROP INDEX on a `USING store` table releases the underlying index `KVStore`, refreshes the connected `StoreTable`'s cached `tableSchema` (removing the entry from `indexes` and any synthesized UNIQUE entry from `uniqueConstraints` via `derivedFromIndex`), clears the `StoreTable.indexStores` cache slot, and emits a `schemaChange` event. Symmetric to `StoreModule.createIndex`.
files:
  packages/quereus-store/src/common/store-module.ts
  packages/quereus-store/src/common/store-table.ts
  packages/quereus-store/test/column-default-conflict.spec.ts
  packages/quereus/test/logic/drop-unique-index.sqllogic
  packages/quereus/src/schema/manager.ts
  packages/quereus/src/vtab/memory/layer/manager.ts
---

## Problem (recap)

`SchemaManager.dropIndex` (`packages/quereus/src/schema/manager.ts:1277`)
already updates the engine-side `TableSchema` (removing both the index
and the `derivedFromIndex`-tagged `UniqueConstraintSchema`) and only
invokes `module.dropIndex` when the module supplies one. `StoreModule`
does not. The connected `StoreTable` therefore retains its
constructor-captured `tableSchema` and continues to:

- maintain entries in the dropped index store from
  `StoreTable.updateSecondaryIndexes`, and
- (for UNIQUE indexes) enforce the synthesized
  `UniqueConstraintSchema` from `StoreTable.checkUniqueConstraints`.

The create-side fix already tagged the synthesized constraint with
`derivedFromIndex: indexSchema.name` (see
`packages/quereus-store/src/common/store-module.ts:343-358`) so the
filter on the drop side is a one-liner — this ticket only needs to
mirror it.

## Design

Add `StoreModule.dropIndex(db, schemaName, tableName, indexName)` that
mirrors `StoreModule.createIndex`
(`packages/quereus-store/src/common/store-module.ts:308-368`) and
`MemoryTableManager.dropIndex`
(`packages/quereus/src/vtab/memory/layer/manager.ts:1329-1379`):

```ts
async dropIndex(
    _db: Database,
    schemaName: string,
    tableName: string,
    indexName: string,
): Promise<void> {
    const tableKey = `${schemaName}.${tableName}`.toLowerCase();
    const table = this.tables.get(tableKey);
    if (!table) {
        throw new QuereusError(
            `Store table '${tableName}' not found in schema '${schemaName}'`,
            StatusCode.NOTFOUND,
        );
    }

    const tableSchema = table.getSchema();
    const lowerIndexName = indexName.toLowerCase();

    // Mirror SchemaManager.dropIndex: strip the index AND any
    // UNIQUE constraint synthesized from it (tagged with
    // `derivedFromIndex` by StoreModule.createIndex). Collapse
    // uniqueConstraints to undefined when empty.
    const updatedIndexes = Object.freeze(
        (tableSchema.indexes ?? []).filter(
            idx => idx.name.toLowerCase() !== lowerIndexName,
        ),
    );
    const remainingUniqueConstraints = (tableSchema.uniqueConstraints ?? []).filter(
        uc => uc.derivedFromIndex?.toLowerCase() !== lowerIndexName,
    );
    const updatedSchema: TableSchema = {
        ...tableSchema,
        indexes: updatedIndexes,
        uniqueConstraints: remainingUniqueConstraints.length > 0
            ? Object.freeze(remainingUniqueConstraints)
            : undefined,
    };
    table.updateSchema(updatedSchema);

    // Drop the cached handle on the table side and tear down the
    // underlying KVStore. `deleteIndexStore` (if the provider
    // implements it) closes the handle before removing the directory;
    // otherwise we just close it.
    await table.releaseIndexStore(indexName);
    if (this.provider.deleteIndexStore) {
        await this.provider.deleteIndexStore(schemaName, tableName, indexName);
    } else {
        await this.provider.closeIndexStore(schemaName, tableName, indexName);
    }

    this.eventEmitter?.emitSchemaChange({
        type: 'drop',
        objectType: 'index',
        schemaName,
        objectName: indexName,
    });
}
```

### `StoreTable.releaseIndexStore`

`StoreTable.indexStores` (`store-table.ts:130`) is a `protected`
lazy-populated cache keyed by index name. Add a public method that
closes and forgets a single entry, so `StoreModule.dropIndex` can clear
any handle that prior INSERTs caused to be cached:

```ts
/** Close and forget a cached index-store handle, if any. */
async releaseIndexStore(indexName: string): Promise<void> {
    const cached = this.indexStores.get(indexName);
    if (!cached) return;
    this.indexStores.delete(indexName);
    try { await cached.close(); } catch { /* close is best-effort */ }
}
```

This sits next to `getSchema` / `updateSchema` (`store-table.ts:175-184`)
and uses the same close-tolerance idiom as `renameTable`'s
`existing.disconnect()` block (`store-module.ts:786-791`).

### Schema update ordering

Update `table.updateSchema(updatedSchema)` BEFORE releasing or deleting
the index store. That way, even if `deleteIndexStore` throws, the
in-memory schema has already lost the index and the next DML won't
attempt to write into the half-deleted store. (The engine-side schema
registry is the canonical source of truth and is updated by
`SchemaManager.dropIndex` after `module.dropIndex` resolves; if our
module throws here, the engine leaves both registries' indexes in
place, but the connected `StoreTable` has the new schema. That's a
narrow inconsistency only on the failure path and matches the pattern
of `createIndex`, which calls `table.updateSchema` before the engine
finalizes its side.)

### What does NOT need changing

- `SchemaManager.dropIndex` (`packages/quereus/src/schema/manager.ts:1277`)
  is already correct — the `derivedFromIndex` filter at
  manager.ts:1322-1324 lands a clean `TableSchema` in the engine
  registry, and the call ordering (module first, then engine update)
  is unchanged.
- `MemoryTableManager.dropIndex` is already correct — see
  `packages/quereus/src/vtab/memory/layer/manager.ts:1329-1379`.
- `StoreModule.createIndex` already tags the synthesized constraint
  with `derivedFromIndex`.
- `StoreTableModule` interface (`store-table.ts:105-116`) is not
  affected — `dropIndex` is a `VirtualTableModule` method, not a
  `StoreTableModule` method.

## Test plan

### Engine-level (already exists)

`packages/quereus/test/logic/drop-unique-index.sqllogic` covers the
three cases (basic, coincident-name preservation, partial UNIQUE). It
is already run by `yarn test` against the memory module and is picked
up automatically by `yarn test:store` against the store module. Today
it passes under memory but fails under store; after this fix it must
pass under both.

### Store-package unit (new)

Add a describe block in
`packages/quereus-store/test/column-default-conflict.spec.ts`, alongside
the existing `CREATE INDEX refreshes cached tableSchema` group, titled
`DROP INDEX refreshes cached tableSchema and releases index store`.
Cases:

1. `drops the UNIQUE constraint synthesized by CREATE UNIQUE INDEX` —
   create table, `CREATE UNIQUE INDEX`, insert one row, assert a
   duplicate is rejected, `DROP INDEX`, assert the previously-rejected
   duplicate is now accepted. This is the direct mirror of the create-
   side `enforces uniqueness for a UNIQUE index created after CREATE
   TABLE` test.
2. `stops maintaining the dropped non-UNIQUE index store on subsequent
   inserts` — create table, `CREATE INDEX`, insert one row, capture
   index-store entry count via `provider.getIndexStore(...)
   .iterate(buildFullScanBounds())` (mirrors line 269-272 of the same
   spec). `DROP INDEX`, insert another row, and assert that no further
   writes land in the (now released) index store — the easiest
   observable is that a fresh `provider.getIndexStore(...)` is empty
   after the drop+insert sequence (the LevelDB provider's
   `deleteIndexStore` would also unlink the directory; the in-memory
   fixture's `closeIndexStore`/`deleteIndexStore` is a no-op, so we
   inspect the freshly-fetched store).
3. `emits a schemaChange event with type='drop', objectType='index'` —
   register an event listener, run `DROP INDEX`, assert exactly one
   matching event.

The in-memory fixture's `createInMemoryProvider` (lines 26-44 of the
same spec) does not currently implement `deleteIndexStore`. Either
leave it absent (StoreModule falls through to `closeIndexStore`, which
is already a no-op for the fixture) or add a no-op
`deleteIndexStore` for parity — both are acceptable. Pick whichever
makes the assertion in case 2 cleanest; the fix code must handle the
no-`deleteIndexStore` path correctly.

## Validation

- `yarn workspace @quereus/store test` — new cases pass; existing
  CREATE INDEX cases still pass.
- `yarn workspace @quereus/quereus test` — `drop-unique-index.sqllogic`
  continues to pass against memory.
- `yarn test:store` — `drop-unique-index.sqllogic` now passes against
  the store module.
- `yarn workspace @quereus/store run typecheck` — clean.
- `yarn workspace @quereus/quereus run lint` — clean.

## TODO

- Add `releaseIndexStore(indexName)` public method to `StoreTable`
  (`packages/quereus-store/src/common/store-table.ts`) — closes and
  removes the cached handle if present, swallowing close failures.

- Implement `StoreModule.dropIndex` in
  `packages/quereus-store/src/common/store-module.ts`, placed
  immediately after `createIndex`. Filter `indexes` by lowercase name
  and `uniqueConstraints` by `derivedFromIndex?.toLowerCase()`,
  collapse `uniqueConstraints` to `undefined` when empty, call
  `table.updateSchema` BEFORE releasing/deleting the store, then call
  `table.releaseIndexStore`, then `provider.deleteIndexStore ??
  closeIndexStore`, then emit the `schemaChange` event.

- Add a `DROP INDEX refreshes cached tableSchema and releases index
  store` describe block to
  `packages/quereus-store/test/column-default-conflict.spec.ts` with
  the three cases listed under "Store-package unit" above.

- Run `yarn workspace @quereus/store test`,
  `yarn workspace @quereus/quereus test`, and `yarn test:store`;
  confirm `drop-unique-index.sqllogic` now passes under the store
  path and the new unit cases pass.

- Run `yarn workspace @quereus/store run typecheck` and
  `yarn workspace @quereus/quereus run lint`; resolve any new findings.
