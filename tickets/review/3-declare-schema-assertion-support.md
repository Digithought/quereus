description: Add assertion support to DECLARE SCHEMA (parse, diff, DDL generation)
dependencies: none
files:
  packages/quereus/src/parser/ast.ts              # DeclaredAssertion type, DeclareItem union
  packages/quereus/src/parser/parser.ts            # declareSchemaStatement, declareAssertionItem
  packages/quereus/src/emit/ast-stringify.ts       # createAssertionToString, declareItemToString
  packages/quereus/src/schema/schema-differ.ts     # computeSchemaDiff, generateMigrationDDL
  packages/quereus/test/logic/50-declarative-schema.sqllogic  # integration tests (steps 54-65)
----

## Summary

Added `ASSERTION` as a supported item type within `DECLARE SCHEMA { ... }` blocks, completing
the pipeline from parsing through diffing to DDL generation.

### What was built

- **AST**: `DeclaredAssertion` interface wrapping `CreateAssertionStmt`, added to `DeclareItem` union
- **Parser**: `ASSERTION` keyword branch in `declareSchemaStatement()` + `declareAssertionItem()` method that reuses existing `createAssertionStatement()`
- **Stringify**: `createAssertionToString()` function, `'createAssertion'` case in `astToString()`, `'declaredAssertion'` case in `declareItemToString()`
- **Schema differ**: assertion diffing in `computeSchemaDiff()` (declared vs actual maps), assertion DDL in `generateMigrationDDL()` (drops before tables, creates after tables)

### Design note

Assertions are always stored in the main schema (see `create-assertion.ts:65` and `drop-assertion.ts:17`).
Tests use `main` schema accordingly. This is a pre-existing limitation — not introduced here.

## Testing / validation

Tests in `50-declarative-schema.sqllogic` steps 54-65 cover:

- Declare schema with an assertion, diff shows `CREATE ASSERTION` DDL (step 55)
- Apply creates the assertion, subsequent diff is empty (step 58)
- Assertion is enforced — commit with violation fails (step 59)
- Valid insert succeeds (step 61)
- Redeclare schema without the assertion, diff shows `DROP ASSERTION` (step 62)
- Apply removes the assertion, violation no longer fails (step 64)
- Multiple assertions in one schema declaration (step 65)
- Both assertions independently enforced (step 65)

## Usage

```sql
declare schema main {
  table accounts {
    id INTEGER PRIMARY KEY,
    balance INTEGER NOT NULL
  }

  assertion positive_balance check (not exists (select 1 from accounts where balance < 0))
}
```

Then `diff schema main` / `apply schema main` will include assertion create/drop DDL.
