description: schema-differ now quotes identifiers in DDL and guards JSON.parse
dependencies: none
files:
  packages/quereus/src/schema/schema-differ.ts
  packages/quereus/test/schema-differ.spec.ts
----
## Summary

Two bugs fixed in `schema-differ.ts`:

### 1. Unquoted identifiers in generateMigrationDDL

`generateMigrationDDL` now uses `quoteIdentifier()` from `ast-stringify.ts` for all
table, view, index, column, and schema names in generated DDL. This ensures names
containing reserved words, spaces, or special characters produce valid SQL.

Affected statements: DROP TABLE/VIEW/INDEX, ALTER TABLE ADD/DROP COLUMN, and the
schema prefix.

### 2. Unguarded JSON.parse in applyTableDefaults

`JSON.parse(defaultVtabArgs)` is now wrapped in try-catch. Malformed JSON throws a
`QuereusError` with a descriptive message including the table name, rather than
propagating a raw SyntaxError.

## Testing

8 new unit tests in `packages/quereus/test/schema-differ.spec.ts`:

- Quotes reserved-word table names (`order`, `group`) in DROP TABLE
- Quotes reserved-word view names (`select`) in DROP VIEW
- Quotes reserved-word index names (`index`) in DROP INDEX
- Quotes reserved-word table/column names in ALTER TABLE
- Quotes schema prefix with special characters (`my schema`)
- Does NOT quote valid non-keyword identifiers (`users`)
- Quotes names with special characters (`my-table`, `has space`)
- Throws QuereusError on malformed defaultVtabArgs JSON

All existing sqllogic tests (50-declarative-schema.sqllogic) continue to pass
unchanged since the names used there are valid non-keyword identifiers.
