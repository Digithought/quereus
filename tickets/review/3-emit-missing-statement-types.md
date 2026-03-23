description: Added missing statement types to astToString — alterTable, analyze, mutatingSubquerySource
dependencies: none
files:
  packages/quereus/src/emit/ast-stringify.ts
  packages/quereus/test/emit-missing-types.spec.ts
----

## Summary

Four AST node types previously fell through to placeholder defaults in `ast-stringify.ts`. Three needed new implementations; `createAssertion` was already wired up.

### What was built

1. **`alterTableToString`** — handles all 5 `AlterTableAction` variants:
   - `renameTable` → `alter table <table> rename to <newName>`
   - `renameColumn` → `alter table <table> rename column <old> to <new>`
   - `addColumn` → `alter table <table> add column <colDef>`
   - `dropColumn` → `alter table <table> drop column <name>`
   - `addConstraint` → `alter table <table> add <constraint>`

2. **`analyzeToString`** — bare `analyze`, with table, with schema.table

3. **`mutatingSubquerySource` case** in `fromClauseToString` — `(DML stmt) as alias [(cols)]`

4. **Wired up** `alterTable` and `analyze` cases in the `astToString` switch (`createAssertion` was already present)

### Key files
- `packages/quereus/src/emit/ast-stringify.ts` — all changes (~30 lines added)
- `packages/quereus/test/emit-missing-types.spec.ts` — 11 tests covering all cases

### Testing
- All 11 tests in `emit-missing-types.spec.ts` pass
- Full build passes
- Full test suite: 1 pre-existing failure (bigint arithmetic, unrelated) — no regressions

### Use cases for validation
- Round-tripping ALTER TABLE statements through parse → AST → stringify
- Round-tripping ANALYZE statements
- SELECT queries with mutating subquery sources in FROM (e.g., `select * from (delete from t returning *) as d`)
- Schema-qualified identifiers in all new statement types
