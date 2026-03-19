description: schema-differ generates unquoted names and has unguarded JSON.parse
dependencies: none
files:
  packages/quereus/src/schema/schema-differ.ts
----
## Problem

Two issues in schema-differ.ts:

### 1. Unquoted identifiers in generated DDL (line 250-278)

`generateMigrationDDL` produces DDL like:
```sql
DROP TABLE IF EXISTS myTable
ALTER TABLE myTable ADD COLUMN col1
```

Table/view/index names are not quoted. If names contain reserved words, spaces, or special characters, the generated DDL will be syntactically invalid.

### 2. Unguarded JSON.parse (line 155-157)

`applyTableDefaults` calls `JSON.parse(defaultVtabArgs)` without try-catch. If the `defaultVtabArgs` string from the declared schema AST is malformed JSON, this throws an unhandled error that propagates as a generic Error rather than a QuereusError with context.

## Expected Behavior

1. All identifiers in generated DDL should be quoted (e.g., `"myTable"`).
2. `JSON.parse` should be wrapped in try-catch and throw a `QuereusError` with a descriptive message.

## TODO

- [ ] Quote table/view/index names in `generateMigrationDDL` output
- [ ] Wrap `JSON.parse` in `applyTableDefaults` with error handling
- [ ] Add test cases for reserved-word table names in migration DDL
