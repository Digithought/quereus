---
description: Implement GENERATED ALWAYS AS computed columns (STORED and VIRTUAL)
dependencies: Schema system (column.ts, table.ts), DML planner (INSERT/UPDATE builders), constraint-builder.ts, parser (already complete)

---

## Overview

The parser fully supports `GENERATED ALWAYS AS (expr) [STORED|VIRTUAL]` syntax (parser.ts ~line 3210). The AST `ColumnConstraint.generated` stores `{ expr, stored }`. The schema layer sets `ColumnSchema.generated = true` but discards the expression and stored/virtual distinction. This task activates computed column evaluation.

## Key Files

- `src/schema/column.ts` — `ColumnSchema` (has `generated: boolean`, needs expression + stored flag)
- `src/schema/table.ts` — `columnDefToSchema()` — where `generated` constraint is processed (~line 140)
- `src/parser/ast.ts` — `ColumnConstraint.generated: { expr, stored }` (~line 424)
- `src/planner/building/dml.ts` or insert/update builders — where column value lists are constructed
- `src/planner/building/expression.ts` — `buildExpression()` — builds plan nodes from AST expressions
- `src/planner/building/constraint-builder.ts` — model for building expressions in column scope
- `src/runtime/emit/constraint-check.ts` — model for evaluating expressions per-row
- `src/runtime/emit/dml-executor.ts` — DML execution (INSERT/UPDATE row construction)
- `test/logic/40-constraints.sqllogic` — add generated column tests here or in a new file

## Architecture

### Schema Enhancement

Extend `ColumnSchema` to store the generation expression and storage mode:

```typescript
interface ColumnSchema {
  // ... existing fields ...
  generated: boolean;
  /** Expression for generated columns */
  generatedExpr?: Expression;
  /** Whether the generated value is stored (true) or computed on read (false/virtual) */
  generatedStored?: boolean;
}
```

Update `columnDefToSchema()` in `table.ts` to extract the expression and stored flag from the AST constraint.

### STORED Columns

Stored generated columns are computed at INSERT/UPDATE time and persisted by the vtab module like any other column value.

**INSERT path:**
- Generated columns must be excluded from the explicit column list (error if user tries to set them)
- After resolving all non-generated column values, evaluate the generated expression using those values
- Insert the computed value into the row at the generated column's position
- The vtab module stores it normally

**UPDATE path:**
- Cannot directly SET a generated column (error)
- After applying SET assignments to non-generated columns, re-evaluate the generated expression using the post-update row values
- Include the recomputed value in the update sent to the vtab module

**SELECT path:**
- Reads the stored value from the vtab module — no special handling needed

### VIRTUAL Columns

Virtual generated columns are computed on read and not stored by the vtab module.

**INSERT/UPDATE path:**
- Same as STORED for validation (cannot SET directly)
- Do NOT include the virtual column's value in the row sent to the vtab module
- The vtab module should not see or store virtual column values

**SELECT path:**
- When projecting rows from the vtab module, the virtual column's position is NULL/absent
- The planner injects a computation node that evaluates the expression using other column values from the same row
- This is similar to how a view's computed expressions are resolved

### Expression Scope

Generated column expressions can only reference other non-generated columns of the same table (not other generated columns, to avoid dependency ordering issues in the first implementation). The expression must be deterministic — leverage the existing `validateDeterministicConstraint()` from `determinism-validator.ts`.

### Interaction with Constraints

- NOT NULL on a generated column: validated after computation
- CHECK constraints: evaluated after generated column computation
- DEFAULT: irrelevant for generated columns (error if both specified)

## TODO

### Phase 1 — STORED generated columns

- Extend `ColumnSchema` with `generatedExpr?: Expression` and `generatedStored?: boolean`
- Update `columnDefToSchema()` to extract expression and stored flag from AST constraint
- In INSERT planner: detect generated columns, exclude from explicit value assignment, build expression evaluation step that runs after non-generated values are resolved
- In UPDATE planner: reject direct SET on generated columns, add re-evaluation step after SET assignments
- Validate determinism of generated expressions at table creation time
- Validate that generated expressions only reference non-generated columns of the same table
- Error if both DEFAULT and GENERATED are specified on the same column
- Tests: basic STORED generated column (insert, select, update), error on direct SET, error on non-deterministic expression, interaction with NOT NULL and CHECK constraints

### Phase 2 — VIRTUAL generated columns

- In INSERT/UPDATE: exclude virtual column values from the row sent to the vtab module (requires vtab module awareness of column positions)
- In SELECT: inject computation node for virtual columns when projecting
- Handle virtual columns in schema introspection (`table_info()`)
- Tests: basic VIRTUAL generated column (insert, select), verify not stored, update triggers recomputation
- Update `docs/sql.md` to document generated columns
