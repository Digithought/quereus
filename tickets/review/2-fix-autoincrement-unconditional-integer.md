description: autoIncrement is unconditionally true for all INTEGER PKs regardless of AUTOINCREMENT keyword
dependencies: none
files:
  packages/quereus/src/schema/column.ts
  packages/quereus/src/schema/table.ts
  packages/quereus/test/autoincrement-schema.spec.ts
----

## Summary

Fixed `autoIncrement` on `PrimaryKeyColumnDefinition` to correctly reflect the `AUTOINCREMENT`
keyword from SQL DDL, rather than unconditionally setting it to `true` for all INTEGER primary keys.

Used Option A (propagate from AST):

1. Added `autoIncrement?: boolean` to `ColumnSchema` (column.ts:32)
2. In `columnDefToSchema` (table.ts:117), propagated `constraint.autoincrement` from the AST
   when processing `primaryKey` column constraints
3. In `findColumnPKDefinition` (table.ts:478), changed from `col.logicalType.name === 'INTEGER'`
   to `col.autoIncrement || false`

Table-level `findConstraintPKDefinition` is unchanged — AUTOINCREMENT is not valid syntax on
table-level PRIMARY KEY constraints, so it correctly leaves the field undefined.

## Test Cases

`test/autoincrement-schema.spec.ts` — 5 tests:

- `INTEGER PRIMARY KEY AUTOINCREMENT` → `autoIncrement: true`
- `INTEGER PRIMARY KEY` (no keyword) → `autoIncrement: false`
- `TEXT PRIMARY KEY` → `autoIncrement: false`
- Table-level `PRIMARY KEY (id)` → `autoIncrement: undefined` (not set)
- Column schema propagation: verifies `ColumnSchema.autoIncrement` is set correctly
