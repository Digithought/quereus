description: StoreModule.alterTable ADD COLUMN / RENAME COLUMN hardcode defaultNotNull=false and ignore the session-level default_column_nullability option, so `alter table t add column x text` gets NULL semantics under store mode but NOT NULL under memory mode
prereq: none
files:
  packages/quereus-store/src/common/store-module.ts
  packages/quereus/src/vtab/memory/layer/manager.ts
  packages/quereus/src/core/database.ts
  packages/quereus/test/logic/41-alter-table.sqllogic
----

The option `default_column_nullability` defaults to `'not_null'` (`packages/quereus/src/core/database.ts:219`). The memory layer manager honors it:

```ts
// packages/quereus/src/vtab/memory/layer/manager.ts:894
const defaultNullability = this.db.options.getStringOption('default_column_nullability');
const defaultNotNull = defaultNullability === 'not_null';
const newColumnSchema = columnDefToSchema(columnDefAst, defaultNotNull);
```

StoreModule.alterTable hardcodes `false` in two branches:

```ts
// packages/quereus-store/src/common/store-module.ts (addColumn)
const newColSchema = columnDefToSchema(change.columnDef, false);
// (renameColumn)
const newColSchema = columnDefToSchema(change.newColumnDefAst, false);
```

Consequence: `alter table t add column required text` behaves differently between modules. Under memory it triggers the "add NOT NULL to populated table" guard; under store it silently succeeds as a nullable column.

This is surfaced by `41-alter-table.sqllogic:131` under `yarn test:store`: the test expects the NOT NULL error; store mode now reaches this line (after the rename fix in `tickets/complete/store-alter-table-rename-unsupported.md`) and fails because the column is added as nullable.

### Fix

In `store-module.ts`, read the session option from `db` and pass it to `columnDefToSchema`, matching the memory layer's pattern. Use the `db` parameter already available on `alterTable`.

### TODO

- Read `db.options.getStringOption('default_column_nullability')` in `addColumn` and `renameColumn` cases of `StoreModule.alterTable` and compute `defaultNotNull` from it.
- Re-run `yarn test:store` and verify `41-alter-table.sqllogic` passes in full.
- Verify existing store unit tests in `packages/quereus-store/test/alter-table.spec.ts` still pass (they explicitly set NULL/NOT NULL so they shouldn't be affected).
