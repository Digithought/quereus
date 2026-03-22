description: Add missing statement types to astToString — alterTable, analyze, createAssertion, mutatingSubquerySource
dependencies: none
files:
  packages/quereus/src/emit/ast-stringify.ts
  packages/quereus/src/parser/ast.ts
  packages/quereus/test/emit-missing-types.spec.ts
----

## Problem

Four AST node types fall through to placeholder defaults in `ast-stringify.ts`:
- `alterTable` → `[alterTable]` (line 116, `astToString` default branch)
- `analyze` → `[analyze]` (same)
- `createAssertion` → `[createAssertion]` (same)
- `mutatingSubquerySource` → `[unknown_from]` (line 498, `fromClauseToString` default branch)

## Root Cause

The `astToString` switch (line 42) has no `case` for `alterTable`, `analyze`, or `createAssertion`.
The `fromClauseToString` switch (line 439) has no `case` for `mutatingSubquerySource`.

## Reproducing Tests

`packages/quereus/test/emit-missing-types.spec.ts` — 11 tests, all currently failing.
Run: `yarn workspace @quereus/quereus test:single --no-bail packages/quereus/test/emit-missing-types.spec.ts`

## Implementation Plan

All changes are in `packages/quereus/src/emit/ast-stringify.ts`. Existing helpers (`columnDefToString`, `tableConstraintsToString`, `expressionToString`, `quoteIdentifier`, `insertToString`, `updateToString`, `deleteToString`) cover most of the needed sub-stringification.

### 1. `alterTableToString(stmt: AlterTableStmt): string`

New function handling all 5 `AlterTableAction` variants:
- `renameTable` → `alter table <table> rename to <newName>`
- `renameColumn` → `alter table <table> rename column <old> to <new>`
- `addColumn` → `alter table <table> add column <columnDefToString(col)>`
- `dropColumn` → `alter table <table> drop column <name>`
- `addConstraint` → `alter table <table> add <tableConstraintsToString([constraint])>`

Table identifier uses `expressionToString(stmt.table)` to handle schema qualification.

### 2. `analyzeToString(stmt: AnalyzeStmt): string`

New function:
- No args → `analyze`
- `tableName` only → `analyze <tableName>`
- `schemaName` + `tableName` → `analyze <schema>.<table>`
- `schemaName` only → `analyze <schema>` (edge case)

### 3. `createAssertionToString(stmt: CreateAssertionStmt): string`

New function:
- `create assertion <name> check (<expressionToString(check)>)`

### 4. `mutatingSubquerySource` case in `fromClauseToString`

Add case at line ~496 (before the `default`):
```
case 'mutatingSubquerySource': {
    const stmtStr = astToString(from.stmt);  // insert/update/delete already handled
    let result = `(${stmtStr}) as ${quoteIdentifier(from.alias)}`;
    if (from.columns && from.columns.length > 0) {
        result = `(${stmtStr}) as ${quoteIdentifier(from.alias)} (${from.columns.map(quoteIdentifier).join(', ')})`;
    }
    return result;
}
```

### 5. Wire up in `astToString` switch

Add three cases before the `default` at line 115:
```
case 'alterTable':
    return alterTableToString(node as AST.AlterTableStmt);
case 'analyze':
    return analyzeToString(node as AST.AnalyzeStmt);
case 'createAssertion':
    return createAssertionToString(node as AST.CreateAssertionStmt);
```

## TODO
- Add `alterTableToString` function covering all 5 AlterTableAction variants
- Add `analyzeToString` function
- Add `createAssertionToString` function
- Add `mutatingSubquerySource` case to `fromClauseToString`
- Wire up `alterTable`, `analyze`, `createAssertion` cases in `astToString` switch
- Verify all 11 tests in `emit-missing-types.spec.ts` pass
- Run full build and test suite
