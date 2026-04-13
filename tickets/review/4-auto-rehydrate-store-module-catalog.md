description: Auto-rehydrate persisted schema in StoreModule via rehydrateCatalog() so APPLY SCHEMA and catalog-driven features work without manual loadAllDDL wiring
dependencies: quereus-store, quereus schema manager
files:
  packages/quereus-store/src/common/store-module.ts
  packages/quereus-store/src/common/index.ts
  packages/quereus-store/test/rehydrate-catalog.spec.ts
  packages/quoomb-web/src/worker/quereus.worker.ts
----

## What Was Built

Added `StoreModule.rehydrateCatalog(db)` — a single-call method that loads all persisted DDL from the catalog store and imports each entry into the in-memory `schemaManager` with error tolerance. A corrupt or unparseable DDL entry is logged, collected, and skipped rather than preventing other tables from loading.

### API

```typescript
const result = await storeModule.rehydrateCatalog(db);
// result.tables:  string[]          — imported table names
// result.indexes: string[]          — imported index names
// result.errors:  RehydrationError[] — collected failures
```

Exported types: `RehydrationResult`, `RehydrationError`.

### Changes

- **`store-module.ts`**: Added `RehydrationResult` / `RehydrationError` types and `rehydrateCatalog()` method. `loadAllDDL()` remains exported as a manual escape hatch.
- **`common/index.ts`**: Exports the two new types.
- **`quereus.worker.ts`** (quoomb-web): Replaced the manual `restorePersistedTables()` method (which called `loadAllDDL()` then `importCatalog()`) with a single `storeModule.rehydrateCatalog(db)` call, with error surfacing.

## Testing / Validation

Test file: `packages/quereus-store/test/rehydrate-catalog.spec.ts`

Key test cases:
- **Rehydrate single table**: CREATE TABLE + INSERT in db1, new db2 + rehydrate → table is queryable
- **Rehydrate multiple tables**: Two tables created and touched → both rehydrate
- **Empty catalog**: No persisted tables → empty result, no errors
- **Corrupt DDL tolerance**: Inject invalid DDL entry into catalog → skipped with error, other tables load fine
- **APPLY SCHEMA after rehydrate**: Create table, rehydrate in new db, declare schema with added column, APPLY SCHEMA → ALTER TABLE ADD COLUMN applied correctly, data preserved
- **APPLY SCHEMA no-op**: Identical schema → DIFF produces no DDL, APPLY is no-op

All 161 store tests pass. All 1724 core quereus tests pass. quoomb-web builds cleanly.

## Usage

Embedders replace:
```typescript
const ddl = await storeModule.loadAllDDL();
await db.schemaManager.importCatalog(ddl);
```
with:
```typescript
const result = await storeModule.rehydrateCatalog(db);
```

Works for both IndexedDB and LevelDB plugins since both use StoreModule.
