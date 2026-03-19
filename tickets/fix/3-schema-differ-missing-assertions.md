description: computeSchemaDiff and generateMigrationDDL ignore assertions
dependencies: none
files:
  packages/quereus/src/schema/schema-differ.ts
----
## Problem

The `SchemaDiff` interface defines `assertionsToCreate` and `assertionsToDrop` fields, and `collectSchemaCatalog` properly collects assertions from the catalog, but:

1. `computeSchemaDiff` never populates `assertionsToCreate` or `assertionsToDrop` — assertions are not diffed at all.
2. `generateMigrationDDL` never emits DDL for assertions — `assertionsToCreate` and `assertionsToDrop` are ignored.

This means `apply schema` will never create or drop assertions as part of declarative schema management.

## Expected Behavior

`computeSchemaDiff` should compare declared assertions against actual assertions (similar to how tables/views/indexes are compared), and `generateMigrationDDL` should generate `CREATE ASSERTION` / `DROP ASSERTION` DDL for assertion diffs.

## Key Context

- The `DeclareSchemaStmt` AST may not yet support assertion declarations — verify before implementing.
- If assertion declarations aren't yet in the parser, this is a plan ticket for the full feature rather than a fix.
- `applyTableDefaults` analog would be needed for assertion DDL generation.

## TODO

- [ ] Verify whether `DeclareSchemaStmt.items` supports a `declaredAssertion` type
- [ ] Add assertion diffing to `computeSchemaDiff`
- [ ] Add assertion DDL generation to `generateMigrationDDL`
- [ ] Add test coverage for assertion diff/apply
