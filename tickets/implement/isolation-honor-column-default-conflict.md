---
description: Update `IsolationModule`'s overlay-level PK / UNIQUE pre-checks to read `ColumnSchema.defaultConflict` / `UniqueConstraintSchema.defaultConflict` so column-level `ON CONFLICT REPLACE|IGNORE|FAIL|ROLLBACK` declared on the table is honored when the statement has no `OR <action>` override. Currently the overlay short-circuits with `UNIQUE constraint failed` before the wrapped memory/lamina vtab's own resolver runs.
files:
  packages/quereus-isolation/src/isolated-table.ts
  packages/quereus-store/test/isolated-store.spec.ts
  packages/quereus/src/vtab/memory/layer/manager.ts
  packages/quereus/src/schema/table.ts
  packages/quereus/src/schema/column.ts
---

# `IsolationModule` honors column-level `defaultConflict`

## Context

`1-fix-or-conflict-clause-semantics` (complete) introduced the three-tier
resolution `args.onConflict ?? perViolationDefault ?? ABORT` and wired it
through `runtime/emit/constraint-check.ts` and the memory vtab's
`vtab/memory/layer/manager.ts`. `IsolatedTable` (the per-connection
overlay wrapper) runs its own merged PK / UNIQUE pre-check before
forwarding to the wrapped table and was never updated.

Three sites in `packages/quereus-isolation/src/isolated-table.ts` are
involved:

- **Live overlay row on insert**, lines 646–657 — direct return of
  `UNIQUE constraint failed` when `args.onConflict` is missing/ABORT.
- **`checkMergedPKConflict`**, line 937 — called for inserts (662) and
  PK-changing updates (704, 737). Returns the constraint result when
  `onConflict` is missing/ABORT.
- **`checkMergedUniqueConstraints`**, line 993 — iterates
  `tableSchema.uniqueConstraints` (called from 666, 707, 742) and
  returns the constraint result per UC when `onConflict` is missing/ABORT.

Reference implementation pattern (manager.ts):

```ts
// packages/quereus/src/vtab/memory/layer/manager.ts:1491
function resolvePkDefaultConflict(schema: TableSchema): ConflictResolution | undefined {
    for (const def of schema.primaryKeyDefinition) {
        const col = schema.columns[def.index];
        if (col && col.defaultConflict !== undefined) return col.defaultConflict;
    }
    return undefined;
}

// manager.ts:562
const pkAction = onConflict ?? resolvePkDefaultConflict(schema) ?? ConflictResolution.ABORT;

// manager.ts:767 (UNIQUE)
const effective = onConflict ?? uc.defaultConflict ?? ConflictResolution.ABORT;
```

## Approach

Route #2 from the fix ticket: resolve the effective action **inside the
overlay** and forward it on the existing `overlay.update({...args})`
path so the wrapped table's own resolver still runs single-source.

The overlay schema synthesised by `IsolationModule.createOverlaySchema`
copies columns from the underlying schema, so `defaultConflict` is
already present on the overlay's `tableSchema.columns[i]` — no schema
changes are required. The only work is in `isolated-table.ts`.

## Design

### Helpers (module-private in `isolated-table.ts`)

```ts
function resolvePkDefaultConflict(schema: TableSchema): ConflictResolution | undefined {
    for (const def of schema.primaryKeyDefinition) {
        const col = schema.columns[def.index];
        if (col?.defaultConflict !== undefined) return col.defaultConflict;
    }
    return undefined;
}

function resolveEffective(
    stmt: ConflictResolution | undefined,
    perConstraint: ConflictResolution | undefined,
): ConflictResolution {
    return stmt ?? perConstraint ?? ConflictResolution.ABORT;
}
```

`resolvePkDefaultConflict` is identical to manager.ts's version. We
intentionally duplicate rather than export from quereus core, because
`quereus-isolation` already imports `ConflictResolution` from the
`@quereus/quereus` barrel and adding a one-line helper there is cheap
compared to widening the public API surface for this single use.

(If a cross-package home is preferred later, the natural location is
`packages/quereus/src/schema/table.ts` next to `findPKDefinition` —
defer that as a separate refactor.)

### Site changes

**1. Live overlay row (insert, line 646–657):**

```ts
if (existingRow) {
    const effective = resolveEffective(args.onConflict, resolvePkDefaultConflict(this.tableSchema!));
    if (effective === ConflictResolution.ABORT
        || effective === ConflictResolution.FAIL
        || effective === ConflictResolution.ROLLBACK) {
        return {
            status: 'constraint',
            constraint: 'unique',
            message: `UNIQUE constraint failed: ${this.tableName} PK.`,
            existingRow: existingRow.slice(0, tombstoneIndex) as Row,
        };
    }
    // IGNORE / REPLACE: forward `effective` to overlay.update so the
    // wrapped vtab's resolver applies the same action.
}
```

Then below where the row falls through to `overlay.update`, pass
`onConflict: effective` instead of `args.onConflict`:

```ts
const overlayRow = [...(values ?? []), 0];
const result = await overlay.update({
    ...args,
    values: overlayRow,
    onConflict: effective,
});
```

To keep `effective` in scope for that downstream call, lift its
declaration above the `if (existingRow)` block (or compute it lazily
inside both branches — pick whichever reads cleanest).

**2. `checkMergedPKConflict` (line 937):**

Add `schema: TableSchema` parameter (or read `this.tableSchema` directly
— it's already a method on the class, so `this.tableSchema` is the
cleaner path, no signature change needed beyond what's already there):

```ts
private async checkMergedPKConflict(
    overlay: VirtualTable,
    newPK: SqlValue[],
    tombstoneIndex: number,
    onConflict?: ConflictResolution,
): Promise<UpdateResult | null> {
    const overlayRow = await this.getOverlayRow(overlay, newPK);
    if (overlayRow) return null;

    const underlyingRow = await this.getUnderlyingRow(newPK);
    if (!underlyingRow) return null;

    const effective = resolveEffective(onConflict, resolvePkDefaultConflict(this.tableSchema!));
    if (effective === ConflictResolution.IGNORE) return { status: 'ok', row: undefined };
    if (effective === ConflictResolution.REPLACE) return null;
    return {
        status: 'constraint',
        constraint: 'unique',
        message: `UNIQUE constraint failed: ${this.tableName} PK.`,
        existingRow: underlyingRow,
    };
}
```

**3. `checkMergedUniqueConstraints` (line 993):**

Inside the per-UC loop, resolve `effective` from `uc.defaultConflict`:

```ts
for (const uc of uniqueConstraints) {
    if (uc.columns.some(idx => newRow[idx] === null)) continue;

    const conflict = await this.findMergedUniqueConflict(overlay, uc.columns, newRow, selfPks, tombstoneIndex);
    if (!conflict) continue;

    const effective = resolveEffective(onConflict, uc.defaultConflict);
    if (effective === ConflictResolution.IGNORE) return { status: 'ok', row: undefined };
    if (effective === ConflictResolution.REPLACE) {
        await this.insertTombstoneForPK(overlay, conflict.pk, tombstoneIndex);
        continue;
    }
    const colNames = uc.columns.map(i => schema!.columns[i].name).join(', ');
    return {
        status: 'constraint',
        constraint: 'unique',
        message: `UNIQUE constraint failed: ${schema!.name} (${colNames})`,
        existingRow: conflict.row,
    };
}
```

**4. Forwarding to `overlay.update`:**

On the insert path at line 673–676 and the update paths at 716–720,
725–729, 750–754, pass an `onConflict` that has been resolved against
PK defaultConflict. Computing the effective action once per
operation at the top of `update()` and using it instead of
`args.onConflict` on every `overlay.update({...args, ...})` forward
keeps the wrapped vtab in agreement with what the overlay decided.

Concretely, at the top of `update()`:

```ts
const effectiveOR = args.onConflict ?? resolvePkDefaultConflict(this.tableSchema!) ?? undefined;
const argsForOverlay: UpdateArgs = effectiveOR !== undefined
    ? { ...args, onConflict: effectiveOR }
    : args;
```

Then use `argsForOverlay` everywhere `...args` currently spreads, and
keep `args.onConflict` only at the conflict-check sites that resolve
their own per-constraint default. Caveat: a UNIQUE constraint may have
a different `defaultConflict` than the PK. If the overlay decides
IGNORE for a UC violation but the wrapped vtab gets the PK default,
that's still correct behavior because the UC check has already
short-circuited with `{ status: 'ok' }` before reaching `overlay.update`.

### Tests

Mirror the three-tier precedence in
`packages/quereus-store/test/isolated-store.spec.ts`, in a new
`describe('column-level ON CONFLICT default (defaultConflict)')` block
under the existing `cross-layer UNIQUE / PK conflict detection` group.

Cases (one `it` each):

- **PK column-level REPLACE, underlying conflict, no OR clause** —
  `CREATE TABLE t (id INTEGER PRIMARY KEY ON CONFLICT REPLACE, v TEXT)`,
  seed `(1,'a')` committed, run plain `INSERT INTO t VALUES (1,'b')`;
  expect row `(1,'b')`.
- **PK column-level IGNORE, underlying conflict, no OR clause** —
  same shape with `ON CONFLICT IGNORE`; expect row `(1,'a')`.
- **Statement OR ABORT overrides column-level REPLACE** —
  `ON CONFLICT REPLACE` declared, but `INSERT OR ABORT INTO t ...`
  should still raise.
- **UNIQUE column-level REPLACE, underlying conflict, no OR clause** —
  `email TEXT UNIQUE ON CONFLICT REPLACE`; second insert at different
  PK but same email replaces the prior row.
- **UNIQUE column-level IGNORE, underlying conflict, no OR clause** —
  same with IGNORE; expect cnt = 1, original row retained.
- **Composite-PK at column level (table-level constraint with action)** —
  `PRIMARY KEY (a,b) ON CONFLICT IGNORE`; second insert at same `(a,b)`
  is silently dropped.
- **Live overlay row** — inside a single `BEGIN ... COMMIT`, insert
  `(1,'a')` then `(1,'b')` with column-level REPLACE; expect `(1,'b')`
  after commit.
- **PK change UPDATE conflicting with another overlay row** — column-
  level REPLACE on PK; `UPDATE` that changes PK to an existing row
  evicts the existing row.

The lamina conformance suite's
`packages/lamina-quereus-test/src/sqllogic/29.1-column-level-on-conflict.sqllogic`
cases 1–5 are the external acceptance signal (they live in the lamina
repo and run through `createSqllogicFixture` which wraps `LaminaModule`
in `IsolationModule`).

## TODO

- Add `resolvePkDefaultConflict` and `resolveEffective` helpers at the
  bottom of `packages/quereus-isolation/src/isolated-table.ts`.
- Lift `effective` computation in the `case 'insert'` block so the live-
  overlay-row branch (line 646) and the fall-through `overlay.update`
  (line 673) both see the resolved action.
- Update `checkMergedPKConflict` to consult `resolvePkDefaultConflict(this.tableSchema)`
  when `onConflict` is undefined.
- Update `checkMergedUniqueConstraints` to consult `uc.defaultConflict`
  per-constraint when `onConflict` is undefined.
- On the four `overlay.update({...args, ...})` forwards (insert at 673,
  update branches at 716, 725, 750), pass the resolved effective action
  so the wrapped vtab's resolver agrees with the overlay's decision.
- Add the eight test cases listed above to
  `packages/quereus-store/test/isolated-store.spec.ts`.
- Run `yarn workspace @quereus/quereus-store test` (and `yarn test` at
  root for the broad sweep) — make sure existing cross-layer cases at
  lines 311–425 still pass with the refactored conflict-check paths.
- Update `packages/quereus-isolation/README.md` (if present) or inline
  doc comments near the conflict-check helpers to note that column-
  level `defaultConflict` is honored via the same three-tier
  resolution as the memory vtab.
