description: autoIncrement is unconditionally true for all INTEGER PKs regardless of AUTOINCREMENT keyword
dependencies: none
files:
  packages/quereus/src/schema/table.ts
  packages/quereus/src/schema/column.ts
  packages/quereus/src/parser/ast.ts (line 420 — already has autoincrement on AST)
----

## Root Cause

In `findColumnPKDefinition` (table.ts:477):

```typescript
autoIncrement: col.logicalType.name === 'INTEGER',
```

This sets `autoIncrement: true` for every INTEGER primary key, even without an explicit
`AUTOINCREMENT` keyword. The parser already correctly parses `AUTOINCREMENT` into the AST
(parser.ts:3224-3226, ast.ts:420), but the value is never propagated to `ColumnSchema`.

The `autoIncrement` field on `PrimaryKeyColumnDefinition` is currently **not consumed** anywhere
in the runtime (no VTab module reads it). However, it's part of the public interface
(`PrimaryKeyColumnDefinition`) and could mislead external VTab implementations or future code
into thinking all INTEGER PKs auto-increment.

Additionally, `findConstraintPKDefinition` (table-level path) never sets `autoIncrement` at all,
creating an asymmetry between the two PK definition paths.

## Fix

Two options (recommend Option A for simplicity since the field is unused):

**Option A — Propagate from AST (correct but more plumbing):**
1. Add `autoIncrement?: boolean` to `ColumnSchema` (column.ts)
2. In table.ts constraint processing (~line 114-117), propagate `constraint.autoincrement` to
   `schema.autoIncrement` when the constraint type is `primaryKey`
3. In `findColumnPKDefinition`, change line 477 to: `autoIncrement: col.autoIncrement || false`

**Option B — Remove dead field:**
1. Remove `autoIncrement` from `PrimaryKeyColumnDefinition`
2. Remove the assignment in `findColumnPKDefinition`
3. Since nothing consumes it, this is safe

## TODO

- [ ] Choose Option A or B (recommend A for future-proofing)
- [ ] Apply the fix
- [ ] Verify no regressions
