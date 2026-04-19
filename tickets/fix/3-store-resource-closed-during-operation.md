description: "LevelDBStore is closed" thrown mid-operation for valid sequences involving DROP TABLE then CREATE/INSERT or CHECK evaluation
dependencies: none
files:
  packages/quereus-plugin-leveldb/src/store.ts
  packages/quereus-store/src/common/store-module.ts
  packages/quereus-store/src/common/store-table.ts
  packages/quereus/test/logic/102-schema-catalog-edge-cases.sqllogic
  packages/quereus/test/logic/40-constraints.sqllogic
  packages/quereus/test/logic/41-alter-table.sqllogic
----

Reproduced under `QUEREUS_TEST_STORE=true` in three places. The error is:

```
Error: LevelDBStore is closed
  at LevelDBStore.checkOpen (.../store.js:98)
  at LevelDBStore.get (.../store.js:30)
  at StoreTable.update (.../store-table.js:379)
```

Triggering patterns:

- `40-constraints.sqllogic:283` — after `DROP TABLE dependent; DROP TABLE ref_table; CREATE TABLE ref_table (...); CREATE TABLE dependent (...); BEGIN; INSERT INTO dependent ...; COMMIT;` the CHECK constraint evaluation hits a closed store
- `102-schema-catalog-edge-cases.sqllogic` — schema-catalog manipulations followed by inserts
- `41-alter-table.sqllogic:104` — row-count mismatch of 0 rows (likely same cause; a scan over a closed store returns empty)

### Hypothesis

`DROP TABLE` (or equivalent schema reset) closes the underlying `LevelDBStore` handle, but the in-session `StoreTable` or its index stores retain references. A subsequent operation hits `checkOpen` and throws. The fix likely lives in either:

- `StoreModule` guaranteeing that a `closeStore` invalidates (and on-next-use reopens) the `StoreTable` wrapper, or
- `StoreTable` re-acquiring its store handle lazily via the provider on each operation

### TODO

- Reproduce in a standalone spec (create → drop → recreate → insert) under `packages/quereus-store/test/`
- Trace the lifetime of the `LevelDBStore` handle across DROP/CREATE
- Decide between "invalidate + reopen" and "lookup per op"; memory mode keeps tables alive through the schema manager, so reopening is the less invasive fix
- Re-run the three failing sqllogic files
