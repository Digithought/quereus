---
description: Implement foreign key constraint enforcement with cascading actions
dependencies: Schema system (table.ts, column.ts), constraint-builder.ts, constraint-check.ts, deferred-constraint-queue.ts, DML planner/emitter pipeline

---

## Overview

Foreign key constraints are fully parsed but not enforced. The parser already handles column-level `REFERENCES` and table-level `FOREIGN KEY ... REFERENCES` with all action types (CASCADE, RESTRICT, SET NULL, SET DEFAULT, NO ACTION) and deferrable semantics. The AST `ForeignKeyClause` is complete. The schema layer has a commented-out `foreignKeys` field on `TableSchema`.

This task activates FK enforcement in two phases: referential validation (child-side checks and parent-side restriction), then cascading actions.

## Key Files

- `src/schema/table.ts` — `TableSchema` (commented-out `foreignKeys` field), `RowConstraintSchema`, constraint helpers
- `src/schema/column.ts` — `ColumnSchema`
- `src/schema/manager.ts` — `SchemaManager.createTable()`, table registration
- `src/parser/ast.ts` — `ForeignKeyClause`, `ForeignKeyAction`, `ColumnConstraint`, `TableConstraint`
- `src/parser/parser.ts` — `foreignKeyClause()`, `parseForeignKeyAction()` (~line 3295)
- `src/planner/building/constraint-builder.ts` — `buildConstraintChecks()` — model for building plan-time constraint expressions
- `src/planner/building/dml.ts` (or related DML builders) — where INSERT/UPDATE/DELETE plans are built
- `src/planner/nodes/constraint-check-node.ts` — `ConstraintCheckNode`, `ConstraintCheck` interface
- `src/runtime/emit/constraint-check.ts` — constraint evaluation at runtime
- `src/runtime/deferred-constraint-queue.ts` — deferred constraint infrastructure
- `src/schema/schema-differ.ts` — declarative schema diffing (needs FK awareness)
- `src/schema/declared-schema-manager.ts` — declarative schema storage
- `test/logic/40-constraints.sqllogic` — existing constraint tests

## Architecture

### Schema Storage

Uncomment and define `ForeignKeyConstraintSchema` on `TableSchema`:

```typescript
interface ForeignKeyConstraintSchema {
  name?: string;
  /** Columns in this (child) table */
  columns: ReadonlyArray<number>; // column indices
  /** Referenced (parent) table */
  referencedTable: string;
  /** Referenced schema (default: same schema) */
  referencedSchema?: string;
  /** Referenced columns (indices into parent table) */
  referencedColumns: ReadonlyArray<number>; // column indices in parent
  /** Action on parent DELETE */
  onDelete: ForeignKeyAction; // default 'noAction'
  /** Action on parent UPDATE of referenced columns */
  onUpdate: ForeignKeyAction; // default 'noAction'
  /** Whether enforcement is deferred to COMMIT */
  deferred: boolean;
}
```

Extract FK definitions during `createTable()` from both column-level and table-level constraints. Validate that referenced tables/columns exist at creation time (or defer validation for forward references in declarative schema).

### Enforcement Model

FK enforcement has two sides:

**Child side (referencing table):**
- On INSERT: verify parent row exists for each FK
- On UPDATE of FK columns: verify new parent row exists

These are equivalent to CHECK constraints with EXISTS subqueries: `exists(select 1 from parent where parent.ref_col = new.fk_col)`. Build them as deferred constraint checks using the existing `buildConstraintChecks` / `DeferredConstraintQueue` infrastructure. They are inherently cross-table, so they should always be deferred (like CHECK constraints with subqueries are today).

**Parent side (referenced table):**
- On DELETE: apply the FK's `onDelete` action
- On UPDATE of referenced columns: apply the FK's `onUpdate` action

Actions:
- **RESTRICT**: Immediate check — fail if any child rows reference the old PK. Synthesize as: `not exists(select 1 from child where child.fk_col = old.pk_col)`
- **NO ACTION**: Same check but deferred to statement end / COMMIT
- **CASCADE**: Generate compensating DML — DELETE matching children (for parent DELETE) or UPDATE children's FK columns (for parent UPDATE)
- **SET NULL**: Generate `UPDATE child SET fk_col = null WHERE fk_col = old.pk_col`
- **SET DEFAULT**: Generate `UPDATE child SET fk_col = default WHERE fk_col = old.pk_col`

### Enforcement Pragma

Add a pragma to control FK enforcement level:

```sql
pragma foreign_keys = on;   -- enforce (default off for backwards compat)
pragma foreign_keys = off;  -- parse but don't enforce (current behavior)
```

This allows gradual adoption and matches SQLite's pragma model.

### Phase 1: Referential Validation

Child-side existence checks and parent-side RESTRICT/NO ACTION. No cascading DML.

### Phase 2: Cascading Actions

CASCADE, SET NULL, SET DEFAULT — requires generating and executing compensating DML within the same transaction. This involves:
- Building sub-plans for the compensating mutations at plan time
- Executing them in the constraint-check pipeline
- Cycle detection to prevent infinite cascades

## TODO

### Phase 1 — Referential validation

- Define `ForeignKeyConstraintSchema` interface in `src/schema/table.ts`
- Uncomment and type `foreignKeys` field on `TableSchema`
- Extract FK definitions during table creation in `SchemaManager.createTable()` — resolve column indices, validate referenced table/columns exist
- Add `foreign_keys` pragma (default off) to control enforcement
- Build child-side FK checks in `constraint-builder.ts`: for each FK on the target table, synthesize an EXISTS subquery checking the parent table; always defer these checks
- Build parent-side RESTRICT/NO ACTION checks: when planning DELETE/UPDATE on a table, query schema for all tables that reference it via FK; for RESTRICT, synthesize an immediate NOT EXISTS check; for NO ACTION, defer to COMMIT
- Add FK-aware logic to `emitConstraintCheck` if needed (may just work via deferred queue)
- Update declarative schema differ to handle FK diffs
- Tests: child-side validation (INSERT/UPDATE rejected when parent missing), parent-side RESTRICT (DELETE/UPDATE rejected when children exist), NO ACTION (deferred to COMMIT), pragma on/off behavior
- Update `docs/sql.md` section 7.6 to document enforcement semantics

### Phase 2 — Cascading actions

- Implement CASCADE DELETE: when deleting parent row, emit sub-DELETE on child table
- Implement CASCADE UPDATE: when updating parent PK, emit sub-UPDATE on child FK columns
- Implement SET NULL: emit sub-UPDATE setting FK columns to NULL
- Implement SET DEFAULT: emit sub-UPDATE setting FK columns to default values
- Add cycle detection for cascading chains (error on cycles)
- Tests: CASCADE DELETE/UPDATE, SET NULL, SET DEFAULT, cycle detection error
