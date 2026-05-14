---
description: A table-level `PRIMARY KEY (a, b) ON CONFLICT REPLACE|IGNORE|FAIL|ROLLBACK` is dropped during schema build — `findConstraintPKDefinition` doesn't propagate the constraint's `onConflict` onto the participating columns' `defaultConflict`, and the existing `resolvePkDefaultConflict` helper only inspects columns. Result: only column-level `ON CONFLICT` is honored; the table-level form silently degrades to ABORT.
files:
  packages/quereus/src/schema/table.ts
  packages/quereus/src/vtab/memory/layer/manager.ts
  packages/quereus-isolation/src/isolated-table.ts
  packages/quereus/test/logic/29.1-column-level-conflict-clause.sqllogic
prereq: isolation-honor-column-default-conflict
---

# Table-level `PRIMARY KEY ... ON CONFLICT <action>` not propagated

## Context

`1-fix-or-conflict-clause-semantics` + `isolation-honor-column-default-conflict`
between them wired `column.defaultConflict` and `uniqueConstraint.defaultConflict`
through the three-tier resolution (`stmt OR > per-constraint default > ABORT`).
PK conflicts use a helper that inspects only **column-level** declarations:

```ts
// packages/quereus/src/vtab/memory/layer/manager.ts:1491
function resolvePkDefaultConflict(schema: TableSchema): ConflictResolution | undefined {
    for (const def of schema.primaryKeyDefinition) {
        const col = schema.columns[def.index];
        if (col && col.defaultConflict !== undefined) return col.defaultConflict;
    }
    return undefined;
}
```

(Mirrored in `packages/quereus-isolation/src/isolated-table.ts`.)

A **table-level** form like

```sql
create table t (a int, b int, primary key (a, b) on conflict replace);
```

parses fine (`TableConstraint.onConflict` is set) but the conflict action is
dropped during schema build. `findConstraintPKDefinition` at
`packages/quereus/src/schema/table.ts:483` builds `PrimaryKeyColumnDefinition[]`
without touching the constraint's `onConflict`. The participating columns'
`defaultConflict` remains undefined, and `resolvePkDefaultConflict` returns
`undefined` → falls through to `ABORT`.

## Fix options

1. Propagate `constraint.onConflict` onto each participating column's
   `defaultConflict` when building the schema (in `findConstraintPKDefinition`
   or its caller). Caveat: a column could also have its own column-level
   `ON CONFLICT`; pick a precedence (column-level wins by spec).
2. Add a `TableSchema.primaryKeyDefaultConflict?: ConflictResolution` field
   that `findConstraintPKDefinition` populates, and have
   `resolvePkDefaultConflict` consult it first (then fall back to column-level).
   This avoids mutating columns and keeps PK-level semantics distinct from
   column-level.

Option 2 is cleaner — the existing `defaultConflict` on a column is for
violations of *that column's* constraints, not the PK as a whole.

## Acceptance

- `create table t (a int, b int, primary key (a, b) on conflict ignore);
   insert into t values (1, 1), (1, 1);` → no error, single row.
- `create table t (... primary key (...) on conflict replace);` → second
  conflicting insert silently replaces.
- Statement-level `OR <action>` still overrides.
- Extend `packages/quereus/test/logic/29.1-column-level-conflict-clause.sqllogic`
  (or add a parallel `29.2-table-level-pk-conflict-clause.sqllogic`) covering
  the table-level form for all four actions.
- Both the plain memory module and `IsolationModule`-wrapped paths pass.
