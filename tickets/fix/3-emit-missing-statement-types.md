description: Add missing statement types to astToString — alterTable, analyze, createAssertion
dependencies: none
files:
  packages/quereus/src/emit/ast-stringify.ts
  packages/quereus/src/parser/ast.ts
----
Three statement types defined in the AST are not handled in `astToString()`, falling through to the default `[${node.type}]` branch:

## Missing types

### `alterTable` (AlterTableStmt)
Actions: renameTable, renameColumn, addColumn, dropColumn, addConstraint.
Needs full stringification for each action variant.

### `analyze` (AnalyzeStmt)
Fields: optional `tableName`, optional `schemaName`.
Simple: `analyze [schema.]table` or just `analyze`.

### `createAssertion` (CreateAssertionStmt)
Fields: `name`, `check` (Expression).
`create assertion <name> check (<expr>)`.

## Also missing: `mutatingSubquerySource` in `fromClauseToString`
The `MutatingSubquerySource` FROM clause type (`(INSERT/UPDATE/DELETE ... RETURNING ...) AS alias`) is not handled by `fromClauseToString`, falling through to `[unknown_from]`.

## TODO
- Add `alterTable` case to `astToString` with `alterTableToString` function covering all AlterTableAction variants
- Add `analyze` case to `astToString`
- Add `createAssertion` case to `astToString`
- Add `mutatingSubquerySource` case to `fromClauseToString`
- Add tests for each new stringification
