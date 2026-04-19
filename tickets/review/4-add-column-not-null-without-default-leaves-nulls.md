description: Review fix — ALTER TABLE ADD COLUMN with NOT NULL and no DEFAULT now fails fast on non-empty tables (both MemoryTable and StoreModule paths), with an error message naming the qualified table and column instead of a later `__rekey_*` leak.
dependencies: StoreModule.alterTable, StoreTable.hasAnyRows, MemoryTable ADD COLUMN guard
files:
  - packages/quereus-store/src/common/store-module.ts (addColumn guard ~L402-L412)
  - packages/quereus-store/src/common/store-table.ts (new `hasAnyRows()` helper)
  - packages/quereus/src/vtab/memory/layer/manager.ts (tightened error message at the addColumn guard)
  - packages/quereus/test/logic/41-alter-table.sqllogic (extended section 5 with qualified-name + empty-table + NULL + literal-DEFAULT cases)
  - packages/quereus-store/test/alter-table.spec.ts (new smoke tests: empty OK, non-empty refused with col+table name, literal DEFAULT OK)

----

## What changed

Both the MemoryTable and StoreModule ALTER TABLE ADD COLUMN paths now refuse a NOT NULL column without a literal DEFAULT when the underlying table already has rows. The rejection happens before any row migration runs, so no NULL ever lands in storage (which previously let a downstream ALTER PRIMARY KEY rekey pipeline report the violation against an internal `__rekey_*` temp name).

Error message format (both paths):

```
Cannot add NOT NULL column '<col>' to non-empty table '<schema>.<table>' without a DEFAULT value
```

Thrown as `QuereusError` with `StatusCode.CONSTRAINT`.

### StoreTable.hasAnyRows()

Short-circuiting helper — iterates the full-scan bounds and returns on the first key. Cheaper than `approximateCount` and avoids deserialization.

### StoreModule.alterTable → addColumn

After the literal DEFAULT is extracted and before `migrateRows`, the guard fires when `newColSchema.notNull && defaultValue === null && await table.hasAnyRows()`. Non-literal DEFAULTs leave `defaultValue === null`, so the guard also refuses them on non-empty tables — matching the strict intent (MemoryTable used to warn-and-fill-with-NULL; now both paths agree).

### MemoryTable manager.ts

Message format aligned to the StoreModule path (includes `schema.table`). The enclosing condition already gated on `tableHasRows`, so no behavior change for the empty-table case.

## Acceptance validation

- `yarn build`: clean.
- `packages/quereus` tests: 2443 passing, 2 pending (unchanged).
- `packages/quereus-store` tests: 170 passing, including three new smoke cases (empty OK, non-empty refused with col+`main.items` in the message, literal DEFAULT OK).
- sqllogic `41-alter-table.sqllogic` section 5 now additionally asserts:
  - error message contains `'rank'`
  - error message contains `main.t_notnull`
  - NULL column without DEFAULT on a non-empty table is allowed
  - NOT NULL without DEFAULT on an empty table is allowed (insert succeeds)

## Use cases to spot-check in review

- Reproduce the original failing path: store-backed table with one row → `ALTER TABLE ... ADD COLUMN ... NOT NULL` should throw `CONSTRAINT` naming the column and `schema.table`, never `__rekey_*`.
- Empty table ADD COLUMN NOT NULL (no DEFAULT): allowed; subsequent INSERT supplies the value.
- Non-empty ADD COLUMN NOT NULL DEFAULT &lt;literal&gt;: allowed, backfill wins.
- Non-empty ADD COLUMN NULL (no DEFAULT): allowed, existing rows get NULL.
- Non-literal DEFAULT expression on non-empty table (e.g., `default (random())`): now refused on both paths. This is the intentional strictness noted in the ticket; confirm it matches project direction or carve out via ticket `plan/2-declarative-schema-enhancements.md`.

## Review checklist

- Error text does not mention `__rekey_`.
- Error text names the column in quotes and the qualified `schema.table`.
- `hasAnyRows()` stops after the first iterated entry (check the `return true` inside the loop).
- Guard runs BEFORE `migrateRows` in StoreModule.alterTable.
- sqllogic + spec tests green on both packages.
