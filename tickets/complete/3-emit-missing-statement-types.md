description: Added missing statement types to astToString — alterTable, analyze, mutatingSubquerySource
files:
  packages/quereus/src/emit/ast-stringify.ts
  packages/quereus/test/emit-missing-types.spec.ts
----

## What was built

Three AST node types that previously fell through to placeholder defaults in `ast-stringify.ts` now have proper emitters:

1. **`alterTableToString`** — handles all 5 `AlterTableAction` variants (renameTable, renameColumn, addColumn, dropColumn, addConstraint)
2. **`analyzeToString`** — bare `analyze`, with table, with schema.table, schema-only
3. **`mutatingSubquerySource`** in `fromClauseToString` — `(DML stmt) as alias [(cols)]`
4. `createAssertion` was already wired — confirmed working

## Key files
- `packages/quereus/src/emit/ast-stringify.ts` — ~30 lines added across 3 functions + 2 switch cases
- `packages/quereus/test/emit-missing-types.spec.ts` — 11 tests

## Review notes
- All functions follow existing patterns and reuse helpers (expressionToString, quoteIdentifier, columnDefToString, tableConstraintsToString)
- `alterTableToString` has explicit `: string` return type so TypeScript enforces exhaustive coverage of all action variants
- No DRY violations, no resource leaks, identifiers properly quoted
- Build passes, all 11 tests pass, no regressions
