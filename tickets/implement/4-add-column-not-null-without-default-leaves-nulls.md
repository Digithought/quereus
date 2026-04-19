description: Fail fast when ALTER TABLE ADD COLUMN introduces a NOT NULL column with no DEFAULT on a non-empty table. Currently the StoreModule path silently writes NULL into every existing row; the violation is then only surfaced later (e.g. when ALTER PRIMARY KEY rekeys through an INSERT-from-SELECT pipeline and the fresh-insert validator fires), producing a confusing error that names an internal `__rekey_*` temp instead of the offending column/table.
dependencies: StoreModule.alterTable (addColumn), StoreTable (new hasAnyRows helper), MemoryTable ADD COLUMN (error-message tightening), declarative differ (emits ADD → ALTER PK → DROP in one apply cycle)
files:
  - packages/quereus-store/src/common/store-module.ts (alterTable → addColumn, ~L393-L430)
  - packages/quereus-store/src/common/store-table.ts (add `hasAnyRows()` helper near existing scan helpers ~L140-L200)
  - packages/quereus/src/vtab/memory/layer/manager.ts (tighten error message at L914-L915 to include table name)
  - packages/quereus/src/runtime/emit/alter-table.ts (callsite, no change expected)
  - packages/quereus/src/schema/schema-differ.ts (ordering reference only — no change)
  - packages/quereus/test/logic/41-alter-table.sqllogic (extend with regression cases)

----

## Scope

Option **A** from the fix ticket: surface the error early. ADD COLUMN with `NOT NULL` and no (literal) DEFAULT on a table that already has rows must throw a `CONSTRAINT` error naming both the column and the qualified table, before any row migration runs. Empty tables remain allowed (SQLite-compatible, matches the existing MemoryTable behavior).

Out of scope: `USING <expr>` backfill; differ-level graceful downgrade; static-analysis pre-flight. Those remain for `plan/2-declarative-schema-enhancements.md`.

## Changes

### 1. StoreTable — add a `hasAnyRows()` helper

`packages/quereus-store/src/common/store-table.ts`, near `rowsWithNullAtIndex` (~L143):

```ts
/** Returns true if the table has at least one stored row. Stops after the first hit. */
async hasAnyRows(): Promise<boolean> {
  const store = await this.ensureStore();
  const bounds = buildFullScanBounds();
  for await (const _entry of store.iterate(bounds)) {
    return true;
  }
  return false;
}
```

Rationale: cheaper than `approximateCount` and avoids pulling row data; we short-circuit on the first key.

### 2. StoreModule.alterTable — guard before `migrateRows`

`packages/quereus-store/src/common/store-module.ts`, inside `case 'addColumn'` (~L393-L416), after `newColSchema` / `defaultValue` are computed and before `migrateRows`:

```ts
if (newColSchema.notNull && defaultValue === null) {
  if (await table.hasAnyRows()) {
    throw new QuereusError(
      `Cannot add NOT NULL column '${newColSchema.name}' to non-empty table `
        + `'${schemaName}.${tableName}' without a DEFAULT value`,
      StatusCode.CONSTRAINT,
    );
  }
}
```

Notes:
- `defaultValue` is only populated for literal DEFAULT today (see `store-module.ts:398-401`). A non-literal default expression leaves `defaultValue === null`, so this guard will also refuse non-empty tables for those — matching the MemoryTable behavior (which logs a warning for non-literal defaults and falls back to NULL fill). That is the intentional, strict behavior.
- `StatusCode.CONSTRAINT` is already imported in this file.

### 3. MemoryTable — tighten error message

`packages/quereus/src/vtab/memory/layer/manager.ts:914-915` currently throws:

```
Cannot add NOT NULL col 'X' without DEFAULT.
```

Update to name the qualified table for parity with the StoreModule path:

```ts
throw new QuereusError(
  `Cannot add NOT NULL column '${newColumnSchema.name}' to non-empty table `
    + `'${this.schemaName}.${this._tableName}' without a DEFAULT value`,
  StatusCode.CONSTRAINT,
);
```

The surrounding conditional at L914 is fine as-is (it already gates on `tableHasRows`). Just upgrade the message.

### 4. Regression coverage

Extend `packages/quereus/test/logic/41-alter-table.sqllogic` — section 1 (ADD COLUMN) — with the four cases from the ticket. Pattern already in the file (`-- error: <substring>`):

```sql
-- ADD COLUMN NOT NULL without DEFAULT on empty table → allowed
create table t_addnn_empty (id integer primary key, name text);
alter table t_addnn_empty add column rank integer not null;
insert into t_addnn_empty values (1, 'Alice', 10);
select * from t_addnn_empty;
→ [{"id": 1, "name": "Alice", "rank": 10}]
drop table t_addnn_empty;

-- ADD COLUMN NOT NULL without DEFAULT on non-empty table → refused, names col+table
create table t_addnn_rows (id integer primary key, name text);
insert into t_addnn_rows values (1, 'Alice');
alter table t_addnn_rows add column rank integer not null;
-- error: Cannot add NOT NULL column 'rank'
-- (message should mention table 'main.t_addnn_rows')

-- ADD COLUMN NOT NULL with literal DEFAULT on non-empty table → allowed, backfill wins
alter table t_addnn_rows add column score integer not null default 0;
select * from t_addnn_rows order by id;
→ [{"id": 1, "name": "Alice", "score": 0}]

-- ADD COLUMN NULL without DEFAULT on non-empty table → allowed, NULLs fine
alter table t_addnn_rows add column nickname text null;
select * from t_addnn_rows order by id;
→ [{"id": 1, "name": "Alice", "score": 0, "nickname": null}]
drop table t_addnn_rows;
```

These exercise the MemoryTable path (the default vtab for plain `create table`). The StoreModule path is exercised in `50-declarative-schema.sqllogic` style tests; add an analogous stanza there if the sqllogic harness reaches the store module in CI (check `50-declarative-schema.sqllogic` for the pattern — the same `alter table ... add column ... not null` on a seeded store table should produce the matching error). If declarative-schema tests don't run against a store-backed catalog by default, the unit coverage on StoreModule is enough; the integration smoke below proves the store path end-to-end.

### 5. Integration smoke (SiteCAD-style)

The live failure surfaced in `packages/site-cad/`. A terse reproduction directly against the engine + store-module (no SiteCAD dependency) is sufficient:

- Create a store-backed table with one row.
- ALTER TABLE ADD COLUMN ... NOT NULL (no DEFAULT).
- Expect `QuereusError` with `StatusCode.CONSTRAINT` whose message contains the column name and the qualified table name, NOT `__rekey_`.

Pick a home for this in the existing quereus-store tests if there's a Mocha/Vitest file touching alterTable; otherwise a new file `packages/quereus-store/test/alter-table-add-column.test.ts` is acceptable (check neighbors for the test harness convention before adding).

## Acceptance

- `yarn build` clean.
- `yarn test` in `packages/quereus` passes, including the new sqllogic cases.
- `yarn test` in `packages/quereus-store` passes (or new test added + passing).
- Error message from the guard never contains `__rekey_` and does contain both the column and `schema.table` identifiers.
- Reproduction SQL in the original ticket now aborts at the ADD COLUMN step with a precise CONSTRAINT error, not during the subsequent ALTER PRIMARY KEY rekey.

## TODO

- Add `hasAnyRows()` to `StoreTable` (store-table.ts).
- Add NOT NULL + non-empty-table guard to `StoreModule.alterTable` addColumn case (store-module.ts).
- Tighten MemoryTable addColumn error message (manager.ts) to name the qualified table.
- Extend `41-alter-table.sqllogic` ADD COLUMN section with the four cases above.
- Add a store-module smoke test for the guard path, or confirm sqllogic covers the store backend.
- Run `yarn build` and `yarn test` across quereus + quereus-store.
- Verify the error message does not reference `__rekey_*`.
