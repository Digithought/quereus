description: Schema() TVF needs schema column and enumeration of all schemas; function_info() also needs all-schema enumeration
dependencies: none
files: packages/quereus/src/func/builtins/schema.ts, packages/quereus/src/schema/manager.ts, packages/quereus/test/logic/06.3.1-schema-all-schemas.sqllogic, docs/sql.md
----

## Problem

The `Schema()` TVF had two issues:
1. No `schema` column — no way to tell which schema an object belongs to.
2. Only enumerated `main` and `temp` schemas, ignoring attached/declared schemas.

The `function_info()` TVF had the same hardcoded main+temp pattern.

## Fix Applied

### Schema() TVF (`packages/quereus/src/func/builtins/schema.ts`)

- Added `schema` (TEXT, non-null) as the **first** column in the return type, containing the schema name (e.g. `'main'`, `'temp'`, or any declared schema name).
- Replaced hardcoded `getMainSchema()` + `getTempSchema()` with iteration over `schemaManager._getAllSchemas()`.
- Updated `processSchemaInstance` to read `schemaInstance.name` and prepend it to every yielded row.

### function_info() TVF (same file)

- Replaced hardcoded `getMainSchema()` + `getTempSchema()` with `schemaManager._getAllSchemas()` loop.
- No new column added (per ticket scope).

### Docs

- Updated `docs/sql.md` schema introspection section to reflect the new `schema` column.

## Test

New test file: `packages/quereus/test/logic/06.3.1-schema-all-schemas.sqllogic`

Covers:
- `schema` column exists and is non-null
- Main-schema objects show `schema = 'main'`
- Non-default (declared) schema objects appear in results
- Both schemas' tables appear together with correct schema values
- Functions appear from all schemas

All 1414 existing tests continue to pass (existing tests select columns by name, not position).

## TODO

- [ ] Review the changes for correctness and edge cases
- [ ] Verify test coverage is sufficient
- [ ] Confirm docs are accurate
