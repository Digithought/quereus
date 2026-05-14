---
description: `dml-executor.ts` UPDATE path coerces `plan.onConflict ?? ConflictResolution.ABORT` before calling `vtab.update()`, so column-level / per-constraint `ON CONFLICT REPLACE|IGNORE|FAIL|ROLLBACK` defaults are NOT honored on UPDATE statements that omit an `OR <action>` clause. The INSERT path (same file) correctly passes `plan.onConflict` raw so the vtab can fall back to its own resolver — UPDATE should match.
files:
  packages/quereus/src/runtime/emit/dml-executor.ts
  packages/quereus/src/vtab/memory/layer/manager.ts
  packages/quereus-isolation/src/isolated-table.ts
prereq: isolation-honor-column-default-conflict
---

# UPDATE path doesn't honor column-level `defaultConflict`

## Context

`1-fix-or-conflict-clause-semantics` (complete) introduced the three-tier
resolution `args.onConflict ?? perViolationDefault ?? ABORT` and wired the
INSERT side. `isolation-honor-column-default-conflict` (complete) just made
`IsolatedTable`'s overlay pre-check honor the same three-tier rule.

The UPDATE path in `dml-executor.ts` was never updated. At
`packages/quereus/src/runtime/emit/dml-executor.ts:499`:

```ts
const args: UpdateArgs = {
    operation: 'update',
    values: newRow,
    oldKeyValues: keyValues,
    onConflict: plan.onConflict ?? ConflictResolution.ABORT,  // <— coerced here
    mutationStatement
};
```

Compare to the INSERT path at lines 366–371 (same file), which keeps `undefined`
explicitly so vtabs can fall back to per-constraint defaults:

```ts
// Pass undefined when there's no statement-level OR clause so the vtab
// can fall back to per-constraint defaultConflict directives. The memory
// module treats undefined as ABORT when no constraint default is set.
onConflict: plan.onConflict,
```

## Symptom

A column declared `PRIMARY KEY ON CONFLICT REPLACE` does **not** make an
`UPDATE` that hits a PK collision silently replace. Repro:

```sql
create table t (id integer primary key on conflict replace, v text) using ...;
insert into t values (1, 'a'), (2, 'b');
update t set id = 2 where id = 1;  -- expected: silent replace; actual: UNIQUE constraint failed
```

`UPDATE ... OR REPLACE` works (statement-level OR overrides). Plain `UPDATE`
should pick up the column-level default.

The isolation overlay at `packages/quereus-isolation/src/isolated-table.ts:961`
already does the right thing if it ever sees `undefined` from above, but
currently it doesn't — the executor flattens to `ABORT` first.

A test case was drafted during the isolation review and removed with an
explanatory comment in `packages/quereus-store/test/isolated-store.spec.ts`
(search for "UPDATE-path column-level defaultConflict is NOT honored").
Restore that test (and the parallel one for the memory module path) once
this fix lands.

## Fix sketch

Change `dml-executor.ts:499` to mirror the INSERT path: `onConflict: plan.onConflict`
(no `?? ABORT`). Then audit `vtab.update()` callers — the memory vtab's resolver
at `packages/quereus/src/vtab/memory/layer/manager.ts:1491` already treats
`undefined` as "fall back to per-constraint default ?? ABORT", so no change
should be needed there. The isolation overlay is already prepared (it computes
`effectiveOR = args.onConflict ?? resolvePkDefaultConflict(schema)` at the top
of `update()`).

Watch for any other `?? ABORT` coercions at the executor/vtab boundary that
mirror this pattern.

## Acceptance

- The repro SQL above (with REPLACE) silently replaces, not raises.
- Same with IGNORE — silent no-op.
- `UPDATE OR ABORT` still raises even when column-level is REPLACE.
- Restore the dropped test in `isolated-store.spec.ts`.
- Add a parallel test against the plain memory module (no isolation layer).
