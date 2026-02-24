---
description: Review GENERATED ALWAYS AS computed columns (STORED and VIRTUAL)
dependencies: none
files:
  - packages/quereus/src/schema/column.ts
  - packages/quereus/src/schema/table.ts
  - packages/quereus/src/parser/lexer.ts
  - packages/quereus/src/planner/building/insert.ts
  - packages/quereus/src/planner/building/update.ts
  - packages/quereus/src/planner/nodes/update-node.ts
  - packages/quereus/src/planner/validation/determinism-validator.ts
  - packages/quereus/src/runtime/emit/update.ts
  - packages/quereus/src/runtime/emit/alter-table.ts
  - packages/quereus/test/logic/41-generated-columns.sqllogic
  - docs/sql.md
---

## Summary

Implemented `GENERATED ALWAYS AS (expr) [STORED|VIRTUAL]` computed columns. Both STORED and VIRTUAL modes are supported syntactically; VIRTUAL currently behaves identically to STORED (storage optimization deferred).

## What Changed

### Schema Layer
- `ColumnSchema` extended with `generatedExpr?: Expression` and `generatedStored?: boolean`
- `columnDefToSchema()` now extracts the expression and stored flag from the AST constraint
- Validation: error if both DEFAULT and GENERATED are specified on the same column
- Lexer: added missing `'generated'` keyword mapping (the token type already existed but wasn't in the keyword lookup table)

### INSERT Path
- `createRowExpansionProjection()` rejects INSERT into generated columns
- When no explicit columns are specified, generated columns are auto-excluded from target columns
- Two-stage projection: first expands source to table structure, then `createGeneratedColumnProjection()` computes generated column values using a scope that only exposes non-generated columns
- Determinism validation on generated expressions at plan time

### UPDATE Path
- Rejects `SET` on generated columns with a clear error
- Automatically appends generated column recomputation assignments (marked `isGenerated: true`)
- Runtime (`emitUpdate`): two-phase evaluation — regular assignments first, then generated column expressions evaluated with `withRowContext()` to override the scan's row context with the post-SET row values

### Validation
- `validateDeterministicGenerated()` added to determinism-validator
- Generated expressions can only reference non-generated columns (enforced by scope setup)
- DEFAULT + GENERATED mutual exclusion enforced in columnDefToSchema

### ALTER TABLE
- `alter-table.ts` column constraint reconstruction now preserves generatedExpr and generatedStored

## Testing

Test file: `test/logic/41-generated-columns.sqllogic`

Tests cover:
- Basic STORED generated column (insert, select, update)
- INSERT with default values on non-generated columns
- UPDATE triggers recomputation
- Error: INSERT into generated column
- Error: UPDATE generated column
- SELECT * includes generated columns
- String concatenation in generated expressions
- NOT NULL on generated column (NULL propagation from inputs)
- CHECK constraint on generated column
- Error: DEFAULT + GENERATED on same column
- Multiple generated columns on same table
- RETURNING with generated columns (INSERT and UPDATE)
- VIRTUAL generated columns (insert, select, update, errors)
- Default mode (omitted STORED/VIRTUAL → VIRTUAL)

All 731 tests pass. Build succeeds.

## Known Limitations

- VIRTUAL columns are currently stored identically to STORED (storage optimization deferred). A future optimization would exclude VIRTUAL column values from the vtab module's stored row and compute them on SELECT.
- Generated columns cannot reference other generated columns (no dependency ordering).
- UPSERT DO UPDATE path does not recompute generated columns after the update assignments.
