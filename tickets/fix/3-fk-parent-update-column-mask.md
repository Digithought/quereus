description: Parent-side FK CHECK fires on UPDATEs that don't touch any referenced column, breaking unrelated UPDATE statements on parent tables
prereq: none
files:
  packages/quereus/src/planner/building/foreign-key-builder.ts
  packages/quereus/src/planner/nodes/constraint-check-node.ts
  packages/quereus/src/runtime/emit/constraint-check.ts
----
## Problem

After commit `19e1963e ticket(implement): fix-fk-validation-and-enforcement`, FK action defaults flipped from `'ignore'`/`'ignore'` to `'restrict'`/`'restrict'`. Pre-`19e1963e`, `buildParentSideFKChecks` skipped synthesis at line 286 (`if (action !== 'restrict') continue;`) for hosts that hadn't declared explicit ON UPDATE/ON DELETE. Post-`19e1963e`, every parent table now receives a synthesised parent-side NOT-EXISTS CHECK that fires on **every** parent UPDATE, regardless of which columns the statement touches.

The codebase already flags the gap at `foreign-key-builder.ts:291-292`:

```typescript
// For UPDATE, only check if the referenced columns are being modified
// (this optimization can be added later; for now check always)
```

That "later" is now: the unconditional firing breaks any UPDATE statement that doesn't touch a parent's PK/referenced column.

## Reproduction 

Schema (paraphrased):

```sql
create table Entity (id text primary key, name text not null, ...);
create table Solid (entity_id text primary key references Entity(id), ...);
```

Statement: `update Entity set name = ? where id = ?`.

Expected: succeeds (no FK reference touched).
Actual: `ConstraintError: CHECK constraint failed: _fk_Solid_entity_id`.

The synthesised parent-side constraint inherits the host-defined `fk.name` (line 299), so the failure surfaces under the child-table's FK name even though the constraint kind is `'fk-parent'` (line 375).

Bisected to `19e1963e` (cause: action default flip + removed fast-out at the child-side builder; the parent-side path is the one that fires on UPDATE).

## Fix

Two-part change:

### Part 1 — Carry referenced-column indices on synthesised parent-side checks

In `packages/quereus/src/planner/nodes/constraint-check-node.ts`, extend `ConstraintCheck`:

```typescript
export interface ConstraintCheck {
  constraint: RowConstraintSchema;
  expression: ScalarPlanNode;
  deferrable?: boolean;
  initiallyDeferred?: boolean;
  needsDeferred: boolean;
  kind?: 'check' | 'fk-child' | 'fk-parent';
  /** For 'fk-parent' UPDATE checks: parent-table column indices the FK references.
   *  When set, the runtime can skip the check when none of these indices changed. */
  referencedColumnIndices?: ReadonlyArray<number>;
}
```

In `packages/quereus/src/planner/building/foreign-key-builder.ts:294`, populate the new field on the parent-side push (the `parentColIndices` is already computed at line 288):

```typescript
checks.push({
  constraint: syntheticConstraint,
  expression,
  deferrable: !isRestrict,
  initiallyDeferred: !isRestrict,
  needsDeferred: !isRestrict,
  kind: 'fk-parent',
  referencedColumnIndices: parentColIndices,  // NEW
});
```

(Child-side builder unaffected — the issue is parent-side only.)

### Part 2 — Skip parent-side FK checks when no referenced column changed

In `packages/quereus/src/runtime/emit/constraint-check.ts`, propagate `referencedColumnIndices` into `ConstraintMetadataEntry` (around line 16) and `emitConstraintCheck`'s metadata builder at line 95.

In `checkCheckConstraints` (line 292), before calling the evaluator, if the operation is `RowOpFlag.UPDATE` and `metadata.kind === 'fk-parent'` and `metadata.referencedColumnIndices` is set:

```typescript
if (
  plan.operation === RowOpFlag.UPDATE &&
  metadata.kind === 'fk-parent' &&
  metadata.referencedColumnIndices
) {
  const numCols = tableSchema.columns.length;
  let anyChanged = false;
  for (const colIdx of metadata.referencedColumnIndices) {
    const oldVal = row[colIdx];           // OLD section: 0..n-1
    const newVal = row[numCols + colIdx]; // NEW section: n..2n-1
    if (!sqlValuesEqual(oldVal, newVal)) {
      anyChanged = true;
      break;
    }
  }
  if (!anyChanged) continue;  // No referenced column modified — parent-side check is a no-op.
}
```

(`sqlValuesEqual` is already imported elsewhere in the runtime; mirror the existing `dml-executor.ts:399` usage.)

This matches the optimisation the existing comment at `foreign-key-builder.ts:291-292` predicted, and aligns with how `runUpdate` at `dml-executor.ts:520` already computes a `changedColumns` mask for the auto-event emit path.

## Why filter at constraint-check time, not at plan time

The constraint-check node receives a flat row containing both OLD and NEW segments — the same shape `runUpdate` uses to compute `changedColumns` for auto-events. Doing the filter at runtime keeps the planning side simple (one synthesised constraint per parent FK, regardless of which columns each UPDATE happens to touch) and reuses the row segments already in scope.

## Out of scope

- Child-side FK checks: only DELETE and UPDATE on the parent need column-aware filtering. Child-side INSERTs and UPDATEs that touch the FK columns must always check.
- Cascading actions (`'cascade'`, `'set null'`, `'set default'`): those go through `runtime/foreign-key-actions.ts`, not the synthesised CHECK path.

## Testing notes

Add a test in `sqllogic` or as a Vitest fixture:

```sql
create table Parent (id text primary key, name text not null);
create table Child (parent_id text primary key references Parent(id));

insert into Parent values ('a', 'x');
insert into Child values ('a');

-- Today: fails with "CHECK constraint failed".
-- Expected: succeeds (no FK column touched).
update Parent set name = 'y' where id = 'a';

-- Should still fail (PK is the FK referenced column):
update Parent set id = 'b' where id = 'a';  -- ConstraintError
```

Plus a regression case where two FKs reference different parent columns and only one is updated.

## References

- SiteCAD bisect record: `tickets/fix/lamina-cutover-update-fk-check-regression.md` (host repo).
- Causal commit in this repo: `19e1963e ticket(implement): fix-fk-validation-and-enforcement` (Nathan Allan, 2026-05-07).
- Existing flag: `foreign-key-builder.ts:291-292` ("for now check always").
- Existing changed-columns computation: `dml-executor.ts:397-402, 432-437, 520-527`.
