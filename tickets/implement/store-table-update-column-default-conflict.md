---
description: `StoreTable.update` in `packages/quereus-store/src/common/store-table.ts` ignores column-level `defaultConflict` declared on the PRIMARY KEY (and on non-PK UNIQUE constraints). The PK-change UPDATE branch and the INSERT branch check `args.onConflict === REPLACE`/`IGNORE` by strict equality, so `args.onConflict === undefined` (now the norm post-`dml-executor-update-path-default-conflict` when no statement-level OR clause is present) collapses to ABORT regardless of `... PRIMARY KEY ON CONFLICT REPLACE` or `... UNIQUE ON CONFLICT IGNORE` directives. The contract documented in `docs/sql.md` (precedence: statement OR > per-constraint default > ABORT) and implemented by `MemoryTable` (`packages/quereus/src/vtab/memory/layer/manager.ts:562,651`) and the isolation overlay (`packages/quereus-isolation/src/isolated-table.ts:630`) is not honored by `StoreTable`. Symptom: when `StoreTable` is exercised without the isolation overlay absorbing the resolution (or in flush paths where the resolved action would matter), the engine returns a UNIQUE-constraint failure instead of REPLACE/IGNORE behavior. Additionally, the UPDATE success path returns `{ status: 'ok', row: coerced }` even when REPLACE evicted a row at the new PK — the new `replacedRow` field consumed by the executor (post `dml-executor-update-replaced-row-not-recorded`) is left undefined.
prereq:
files:
  packages/quereus-store/src/common/store-table.ts
  packages/quereus-store/test/unique-constraints.spec.ts
---

## Background

Three peer implementations of the documented PK-conflict precedence rule
live in the codebase. Two of them implement it; `StoreTable` does not.

| Implementation | Resolves column-level default? | Reference |
| --- | --- | --- |
| `MemoryTable` (`performInsert`, `performUpdateWithPrimaryKeyChange`) | Yes — `onConflict ?? resolvePkDefaultConflict(schema) ?? ABORT` | `packages/quereus/src/vtab/memory/layer/manager.ts:562,651` |
| `IsolatedTable` (overlay pre-check) | Yes — sets `effectiveOR = args.onConflict ?? resolvePkDefaultConflict(this.tableSchema!)` and propagates it to the wrapped overlay vtab | `packages/quereus-isolation/src/isolated-table.ts:630` |
| `StoreTable` (`update` INSERT + UPDATE PK-change branches) | **No** — bare `args.onConflict === REPLACE`/`IGNORE` checks | `packages/quereus-store/src/common/store-table.ts:597-610,686-700` |

Both reference copies of the helper:

```ts
function resolvePkDefaultConflict(schema: TableSchema): ConflictResolution | undefined {
  if (schema.primaryKeyDefaultConflict !== undefined) return schema.primaryKeyDefaultConflict;
  for (const def of schema.primaryKeyDefinition) {
    const col = schema.columns[def.index];
    if (col?.defaultConflict !== undefined) return col.defaultConflict;
  }
  return undefined;
}
```

`StoreTable` needs the same helper (locally — neither existing copy is
exported) plus the same precedence wiring at three call sites:

1. INSERT, when an existing row sits at the inserted PK (line ~597).
2. UPDATE, PK-change branch, when an existing row sits at the new PK
   (line ~686).
3. `checkUniqueConstraints` (line ~890), which also raw-matches
   `onConflict === IGNORE`/`REPLACE` without consulting per-UC
   `defaultConflict` (defined on `UniqueConstraintSchema.defaultConflict`
   at `packages/quereus/src/schema/table.ts:435`). Same shape — each
   UC's own default is consulted as the middle tier.

### Why the existing logic tests don't catch this

`yarn test:store` registers the store module as `createIsolatedStoreModule({ provider })`
(see `packages/quereus/test/logic.spec.ts:507-509`), so the isolation
overlay's pre-check resolves the column-level default before the call
ever reaches `StoreTable.update`. The PK-change UPDATE under REPLACE is
also rewritten by the overlay into a tombstone-at-old-PK plus a
same-PK update-at-new-PK during flush, which never re-enters the
PK-change branch. The gap is exposed only by exercising `StoreModule`
directly (no isolation wrap) — exactly the pattern already used by
`packages/quereus-store/test/unique-constraints.spec.ts`.

### `replacedRow` follow-up

`dml-executor-update-replaced-row-not-recorded` (already in
`tickets/complete/`) makes the executor consume `UpdateResult.replacedRow`
on UPDATE results so the ON DELETE side of the evicted row can fire.
`MemoryTable.performUpdateWithPrimaryKeyChange` populates it (manager.ts
line ~660). `StoreTable` UPDATE returns `{ status: 'ok', row: coerced }`
(store-table.ts line ~755) unconditionally, even when REPLACE evicted a
row at the new PK. Populate `replacedRow` with the deserialized
`existingAtNew` row in the REPLACE branch so cascading delete/SET NULL
on the evicted row fires correctly through the store path.

## Fix shape

### 1. Local helper

Add at the top of `store-table.ts` (mirroring the two existing copies):

```ts
function resolvePkDefaultConflict(schema: TableSchema): ConflictResolution | undefined {
  if (schema.primaryKeyDefaultConflict !== undefined) return schema.primaryKeyDefaultConflict;
  for (const def of schema.primaryKeyDefinition) {
    const col = schema.columns[def.index];
    if (col?.defaultConflict !== undefined) return col.defaultConflict;
  }
  return undefined;
}
```

### 2. INSERT branch (~line 597-610)

Replace the strict-equal switch with a resolved action that also feeds
`checkUniqueConstraints`:

```ts
const effective = args.onConflict ?? resolvePkDefaultConflict(schema) ?? ConflictResolution.ABORT;
if (existing) {
  if (effective === ConflictResolution.IGNORE) return { status: 'ok', row: undefined };
  if (effective !== ConflictResolution.REPLACE) {
    return {
      status: 'constraint',
      constraint: 'unique',
      message: `UNIQUE constraint failed: ${this.tableName} PK.`,
      existingRow: deserializeRow(existing),
    };
  }
}
// pass `effective` (not `args.onConflict`) into checkUniqueConstraints
```

### 3. UPDATE PK-change branch (~line 686-700)

```ts
if (pkChanged) {
  const existingAtNew = await store.get(newKey);
  if (existingAtNew) {
    const effective = args.onConflict ?? resolvePkDefaultConflict(schema) ?? ConflictResolution.ABORT;
    if (effective === ConflictResolution.IGNORE) return { status: 'ok', row: undefined };
    if (effective !== ConflictResolution.REPLACE) {
      return {
        status: 'constraint',
        constraint: 'unique',
        message: `UNIQUE constraint failed: ${this.tableName} PK.`,
        existingRow: deserializeRow(existingAtNew),
      };
    }
    // REPLACE: eviction happens implicitly because newKey gets overwritten
    // below by the put(newKey, ...). Capture replacedRow for the return.
  }
}
```

Plumb `replacedAtNewPk: Row | null` (the deserialized `existingAtNew`
when REPLACE fired) through to the success return at line ~755:

```ts
return { status: 'ok', row: coerced, replacedRow: replacedAtNewPk ?? undefined };
```

Pass the resolved `effective` action (not raw `args.onConflict`) into
`checkUniqueConstraints` for the UPDATE call at line 712-717, matching
the INSERT change.

### 4. `checkUniqueConstraints` (~line 890)

Apply the precedence per-UC inside the loop — each UC's
`defaultConflict` is consulted as the middle tier (statement OR > per-UC
default > ABORT):

```ts
const effective = onConflict ?? uc.defaultConflict ?? ConflictResolution.ABORT;
if (effective === ConflictResolution.IGNORE) return { status: 'ok', row: undefined };
if (effective === ConflictResolution.REPLACE) {
  await this.deleteRowAt(inTransaction, conflict.pk, conflict.row);
  continue;
}
// fall through to constraint return
```

This brings non-PK UNIQUE behavior in line with the
`uniq_replace`-style test in section 3 of the logic file when the
store path is reached directly.

### 5. Event emission under REPLACE

When the UPDATE PK-change branch evicts a row at the new PK, the
existing event-emission code (line ~740-753) emits an `update` event
for the moved row but does **not** emit a `delete` event for the
evicted row. Check whether `MemoryTable`'s equivalent path emits a
delete-for-evictee event; if so, match the contract. If not, leave
event emission alone — keep this fix focused on the conflict-resolution
correctness and `replacedRow` propagation.

## Test plan

Add a new spec
`packages/quereus-store/test/column-default-conflict.spec.ts` (modeled
on `unique-constraints.spec.ts`) that registers `StoreModule` directly
(no isolation wrap) and exercises:

- INSERT into `(a integer primary key on conflict replace, b text)` with
  a duplicate PK → second insert silently replaces.
- INSERT into `(a integer primary key on conflict ignore, b text)` with
  a duplicate PK → second insert silently dropped.
- INSERT into `(id integer primary key, email text unique on conflict replace)`
  with a duplicate email → second insert replaces.
- UPDATE on `(id integer primary key on conflict replace, v text)` that
  collides on a different PK → row at colliding PK is replaced, and
  REPLACE eviction is observable in the post-state (cascading FK
  behavior is verified by the existing logic tests via the executor;
  here the spec just asserts the post-state of the table after UPDATE
  matches sections 7 and 9 of
  `packages/quereus/test/logic/29.1-column-level-conflict-clause.sqllogic`).
- UPDATE on `(id integer primary key on conflict ignore, v text)` that
  collides on a different PK → no-op (both rows untouched).
- Statement-level `OR ABORT` on UPDATE/INSERT must still override the
  column-level directive (mirror section 6 of the logic file).
- (Optional) Direct `vtab.update({ operation: 'update', ..., onConflict: undefined })`
  call with a PK-collision asserts the returned `UpdateResult` has
  `status: 'ok'` and the `replacedRow` field populated with the evicted
  row.

Also re-run `yarn test:store` to confirm no regression of the
isolation-wrapped path (sections 7 and 8 still pass).

## TODO

- [ ] Add local `resolvePkDefaultConflict` helper at the top of
      `packages/quereus-store/src/common/store-table.ts`.
- [ ] INSERT branch (line ~597-610): replace strict-equal checks with
      the three-tier resolved `effective` action; pass `effective` into
      `checkUniqueConstraints`.
- [ ] UPDATE PK-change branch (line ~686-700): same resolution; capture
      `existingAtNew` as `replacedRow` on REPLACE; pass `effective` into
      `checkUniqueConstraints` for the UPDATE call.
- [ ] UPDATE success return (line ~755): include `replacedRow` field
      when REPLACE fired.
- [ ] `checkUniqueConstraints` (line ~890): consult each UC's
      `defaultConflict` as the middle tier (statement OR > per-UC default
      > ABORT).
- [ ] Add `packages/quereus-store/test/column-default-conflict.spec.ts`
      (modeled on `unique-constraints.spec.ts`) covering INSERT REPLACE,
      INSERT IGNORE, UNIQUE REPLACE, UPDATE PK-collision REPLACE, UPDATE
      PK-collision IGNORE, and statement-level OR override.
- [ ] Investigate whether REPLACE eviction during the UPDATE PK-change
      branch should emit a `delete` event for the evicted row (compare
      against `MemoryTable` behavior at `manager.ts:655-661`). If yes,
      add the emission; if no, leave events alone — record the decision
      in the review handoff.
- [ ] Run `yarn workspace @quereus/quereus-store test` and confirm the
      new spec passes.
- [ ] Run `yarn test:store` and confirm no regression in
      `29.1-column-level-conflict-clause.sqllogic` sections 7-10
      (isolation-wrapped flush still works).
- [ ] Run `yarn test` to confirm the memory path is unaffected.
