---
description: `IsolationModule`'s overlay-level uniqueness pre-check at `quereus-isolation/src/isolated-table.ts:650` (and the parallel `checkMergedPKConflict` / `checkMergedUniqueConstraints` paths) only consults `args.onConflict` (the statement-level OR clause). It never reads `column.defaultConflict` / `UniqueConstraintSchema.defaultConflict` / the synthesised `_pk_<table>` index's `defaultConflict`. Downstream vtabs that opted in to per-constraint defaults (memory vtab, lamina vtab) never see the row — the IsolationModule short-circuits with `UNIQUE constraint failed` before the wrapped table can run its own resolver.
files:
  packages/quereus-isolation/src/isolated-table.ts
  packages/quereus-store/test/isolated-store.spec.ts
  packages/quereus/src/schema/column.ts
  packages/quereus/src/schema/table.ts
---

# `IsolationModule` must honor column-level `defaultConflict`

## Background

`1-fix-or-conflict-clause-semantics` (complete) landed the three-tier
resolution `args.onConflict ?? perViolationDefault ?? ABORT` for the
memory vtab's `manager.ts`:

- `ColumnSchema.defaultConflict`, `UniqueConstraintSchema.defaultConflict`,
  `RowConstraintSchema.defaultConflict`, `ForeignKeyConstraintSchema.defaultConflict`
  are populated by `columnDefToSchema` / `extractCheckConstraints` /
  `extractUniqueConstraints`.
- `runtime/emit/constraint-check.ts` calls `pickAction(stmtOR, constraint.defaultConflict)`
  per row.
- Memory vtab `vtab/memory/layer/manager.ts` honors per-constraint
  `defaultConflict` for UNIQUE/PK at conflict-resolution time.

`IsolationModule` (`packages/quereus-isolation/src/isolated-table.ts`)
wraps `MemoryTableModule` to give the conformance suite layered
overlay/underlying semantics. It runs its own PK / UNIQUE conflict
detection against the merged overlay+underlying view before forwarding
to the wrapped table — and that pre-check was not updated to read
`defaultConflict`.

## Repro

```ts
const sql = `
  create table t (id integer primary key on conflict replace, v text);
  insert into t values (1, 'first');
  insert into t values (1, 'second'); -- should silently replace
  select v from t where id = 1; -- expected 'second'
`;
```

Against `MemoryTableModule` directly (per `1-fix-or-conflict-clause-semantics`'s
own tests): second INSERT replaces. Through the `IsolationModule`
overlay: second INSERT raises `UNIQUE constraint failed: t PK.`

## Cause

`packages/quereus-isolation/src/isolated-table.ts:650`:

```ts
if (existingRow) {
    // Live row already in overlay for this PK. ...
    if (!args.onConflict || args.onConflict === ConflictResolution.ABORT) {
        return {
            status: 'constraint',
            constraint: 'unique',
            message: `UNIQUE constraint failed: ${this.tableName} PK.`,
            existingRow: existingRow.slice(0, tombstoneIndex) as Row,
        };
    }
}
```

Symmetric sites:

- `checkMergedPKConflict` (called from line 662, 704, 737) — receives
  only `args.onConflict`, signature `onConflict?: ConflictResolution` at
  line 941.
- `checkMergedUniqueConstraints` (called from line 666, 707, 742) — same
  shape at line 998.

Neither path receives the table schema, so neither can resolve a
column-level `defaultConflict` even if it wanted to.

## Required behaviour

When `args.onConflict` is undefined and a PK / UNIQUE violation is
detected against the merged overlay view, resolve the effective action:

- **PK conflict**: walk `tableSchema.primaryKey.columns[]` (or whatever
  upstream representation gives the PK column list) and take the first
  non-undefined `ColumnSchema.defaultConflict`. Fall back to the
  synthesised `_pk_<table>` index descriptor's `defaultConflict` for
  composite-PK tables that author the directive on the constraint rather
  than the column.
- **UNIQUE conflict**: read the violating `UniqueConstraintSchema.defaultConflict`
  by constraint name (the same constraint the merged-uniqueness scan
  matched).
- Effective = `args.onConflict ?? resolved ?? ConflictResolution.ABORT`.

Once the effective action is known, two implementation routes:

1. **Honor in the overlay** — IGNORE: drop the row; REPLACE: delete the
   conflicting overlay row + retry (the existing
   `tombstone → re-insert` path covers part of this); FAIL/ABORT/ROLLBACK:
   surface the rejection as today.
2. **Forward to the wrapped table** — pass `args.onConflict` through
   with the resolved value so `MemoryTableModule` / the wrapped vtab's
   own resolver handles it. This keeps the resolver single-source
   (matches the `1-fix-or-conflict-clause-semantics` shape) but requires
   the overlay to know whether the wrapped vtab has implemented per-
   constraint defaults — `MemoryTableModule` has; arbitrary external
   vtabs may not.

Recommendation: route #2 for the path that already forwards through
`overlay.update({...args})` and add a feature gate (e.g. an opt-in flag
on the wrapped module) so external modules without per-constraint
support keep the conservative ABORT behaviour.

## Acceptance

- Add tests in `packages/quereus-store/test/isolated-store.spec.ts`
  mirroring the three-tier precedence cases for PK + UNIQUE + composite-PK
  through the IsolationModule wrapper.
- The lamina conformance suite's sqllogic 29.1 cases 1–5 should pass
  through `createSqllogicFixture` (which wraps `LaminaModule` in
  IsolationModule); see
  `packages/lamina-quereus-test/src/sqllogic/29.1-column-level-on-conflict.sqllogic`
  in the lamina repo for the reference cases.
