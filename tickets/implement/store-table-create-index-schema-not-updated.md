---
description: After `CREATE INDEX` on a `USING store` table, refresh the connected StoreTable's cached `tableSchema.indexes` so subsequent INSERT/UPDATE/DELETE actually maintain the new index.
files:
  packages/quereus-store/src/common/store-module.ts
  packages/quereus-store/src/common/store-table.ts
  packages/quereus-store/test/column-default-conflict.spec.ts
---

## Root cause

`SchemaManager.createIndex` (packages/quereus/src/schema/manager.ts:1178-1187) calls
`vtabModule.createIndex(...)` and *then* calls `schema.addTable(updatedTableSchema)`
to register the new schema. The schema-manager update lands in the in-memory
registry, but the already-connected `StoreTable` instance still holds the
`tableSchema` reference captured at connect-time (store-table.ts:153) — its
`updateSecondaryIndexes` loop (store-table.ts:851) iterates `this.tableSchema.indexes`
and never sees the new index.

`StoreModule.alterTable` already handles every analogous case by calling
`table.updateSchema(updatedSchema)` after each branch (store-module.ts:443,498,539,579,663).
`createIndex` is the lone DDL path that mutates the schema without telling the
StoreTable.

## Fix

In `StoreModule.createIndex` (store-module.ts:308), after `buildIndexEntries`
completes successfully, compose an updated schema with the new index appended
and apply it to the cached table:

```ts
const updatedIndexes = Object.freeze([
    ...(tableSchema.indexes ?? []),
    indexSchema,
]);
const updatedSchema: TableSchema = { ...tableSchema, indexes: updatedIndexes };
table.updateSchema(updatedSchema);
```

Place the call between `buildIndexEntries` and the `emitSchemaChange`, so the
in-memory schema is consistent before any observer reacts to the event.

Notes:
- Do not also call `saveTableDDL` here. `generateTableDDL` produces only the
  `CREATE TABLE` text; secondary-index persistence across restarts is handled
  by a separate `CREATE INDEX` catalog entry path (out of scope for this fix —
  if the rehydration story for store-side indexes is broken, that's a
  follow-up). This fix is purely about in-memory consistency for the lifetime
  of the connected table.
- `pkDirections` does not need recomputing — only `primaryKeyDefinition`
  affects it, and that hasn't changed.

## Regression test

Add to `packages/quereus-store/test/column-default-conflict.spec.ts` (the
provider exposes individual stores by key, so the test can directly inspect
the index store):

```ts
describe('CREATE INDEX refreshes cached tableSchema', () => {
    it('maintains the new index on inserts and updates issued after CREATE INDEX', async () => {
        await db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, b INTEGER) USING store`);
        await db.exec(`INSERT INTO t VALUES (1, 100)`);
        await db.exec(`CREATE INDEX t_b ON t (b)`);
        await db.exec(`INSERT INTO t VALUES (2, 200)`);
        await db.exec(`UPDATE t SET b = 999 WHERE id = 1`);
        await db.exec(`DELETE FROM t WHERE id = 2`);

        // Inspect the index store directly — should reflect exactly the live rows.
        const idxStore = await provider.getIndexStore('main', 't', 't_b');
        let entryCount = 0;
        for await (const _entry of idxStore.iterate({})) entryCount++;
        expect(entryCount).to.equal(1); // only (b=999, pk=1) remains
    });
});
```

If `iterate({})` is the wrong empty-bounds shape for `InMemoryKVStore`,
import `buildFullScanBounds` from `../src/common/key-builder.js` and pass that
instead (mirrors how production code scans the index store, e.g.
store-module.ts:572).

## TODO

- Apply the `table.updateSchema(...)` call in `StoreModule.createIndex` per the
  fix sketch above.
- Add the regression test above to `column-default-conflict.spec.ts` (or rename
  the file if it grows beyond its original scope — keeping it for now is fine).
- Run `yarn workspace @quereus/store test` and confirm the new test fails on
  `main` and passes after the fix.
- Run `yarn test` from repo root and `yarn lint` in `packages/quereus` (the only
  package with a lint script) to confirm no regressions.
- After this lands, the related ticket `store-table-pk-change-update-leaks-moved-row-index`
  becomes testable at the index-store level — leave that as a separate ticket.
