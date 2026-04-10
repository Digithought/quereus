description: Schema() TVF now has schema column and enumerates all schemas; function_info() also enumerates all schemas
dependencies: none
files: packages/quereus/src/func/builtins/schema.ts, packages/quereus/src/schema/manager.ts, packages/quereus/test/logic/06.3.1-schema-all-schemas.sqllogic, docs/sql.md
----

## Summary

The `Schema()` TVF previously lacked a `schema` column and only enumerated `main` and `temp` schemas. Both issues are fixed:

- **schema column**: Added `schema` (TEXT, non-null) as the first column in the `Schema()` TVF return type, containing the schema name (e.g. `'main'`, `'temp'`, or any declared schema name).
- **All-schema enumeration**: Both `schemaFunc` and `functionInfoFunc` now iterate `schemaManager._getAllSchemas()` instead of hardcoding main+temp.

## Key Changes

- `packages/quereus/src/func/builtins/schema.ts`: Schema column added at position 0; `processSchemaInstance` receives a `Schema` instance and reads `.name`; both TVFs iterate all schemas via `_getAllSchemas()`.
- `docs/sql.md`: Schema introspection section updated to list `schema` as a column and show it in example queries.

## Test Cases (`06.3.1-schema-all-schemas.sqllogic`)

1. `schema` column exists and shows `'main'` for main-schema objects
2. All rows have a non-null `schema` column
3. Non-default (declared) schema objects appear with correct schema name
4. Both main and declared schema tables appear together with correct values
5. Functions from all schemas appear (built-in functions in `'main'`)

## Validation

- All 1415 quereus tests pass (existing tests select columns by name, not position, so the new column is non-breaking)
- Full workspace test suite passes
