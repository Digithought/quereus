description: Enforce UNIQUE constraints in the store module's DML path
dependencies: none
files:
  packages/quereus-store/src/common/store-table.ts
  packages/quereus-store/src/common/store-module.ts
  packages/quereus/src/schema/table.ts (types: UniqueConstraintSchema, TableSchema.uniqueConstraints)
  packages/quereus/src/vtab/memory/layer/manager.ts (reference: memory mode's checkUniqueConstraints / ensureUniqueConstraintIndexes)
  packages/quereus/test/logic/102-unique-constraints.sqllogic (regression under `yarn test:store`)
----

## Problem

Under `QUEREUS_TEST_STORE=true`, `102-unique-constraints.sqllogic:19` fails:

```
Actual:   {"cnt": 3}
Expected: {"cnt": 2}
```

`StoreTable.update` (`packages/quereus-store/src/common/store-table.ts:499`) only
checks primary-key collision (line 513–527). It never consults
`tableSchema.uniqueConstraints`, so a duplicate `email` value is silently
accepted. `updateSecondaryIndexes` (line 671) just writes index entries without
checking first, and `schema.indexes` in store mode does not auto-include
unique-backing indexes — memory mode adds those internally via
`MemoryTableManager.ensureUniqueConstraintIndexes` (`packages/quereus/src/vtab/memory/layer/manager.ts:79`),
which the store module does not mirror.

## Fix

Add UNIQUE-constraint enforcement to `StoreTable.update`, mirroring memory
mode's semantics:

- INSERT: after PK-collision handling, if no PK conflict, check every
  `schema.uniqueConstraints` entry against existing rows. If a different row
  already holds the same constrained values, return
  `{ status: 'constraint', constraint: 'unique', message: 'UNIQUE constraint
  failed: <table>.<cols>', existingRow }` (consistent with the PK path).
- UPDATE (same PK): only check constraints whose covered columns actually
  changed between `oldRow` and `newRow` (avoid self-conflicts). Conflict rules
  same as INSERT, but the "other row" must have a PK distinct from the target.
- UPDATE (PK-change): treat as INSERT at the new PK position — check all
  constraints. If violation, do not mutate state.
- DELETE: no unique check needed.

### NULL semantics

Per SQL standard and memory mode, multiple NULLs are allowed. Skip a
constraint check if any covered column in `newRow` is NULL (see
`checkSingleUniqueConstraint` at `manager.ts:737`).

### Conflict resolution

Honor `args.onConflict`:

- `IGNORE`: return `{ status: 'ok', row: undefined }` without writing.
- `REPLACE`: delete the conflicting existing row, then proceed with the
  insert/update. Emit a `delete` event for the replaced row (or a combined
  `update` if semantics allow).
- Default (`ABORT`/none): return a `constraint` result.

### Implementation approach

Two options; pick the simpler first unless benchmarks demand more:

**Option A (recommended — simple):** Full-scan the primary data store to
detect conflicts for each unique constraint check. Correct for all cases,
works without any schema mutation. Acceptable given the tests use tiny tables
and this mirrors memory's `checkUniqueByScanning` fallback.

**Option B (optimized):** Auto-create a matching secondary index store per
unique constraint (mirror `ensureUniqueConstraintIndexes`) and do prefix scans
on that index. Requires ensuring the index store is populated on first open
and maintained by `updateSecondaryIndexes`. More code and DDL bookkeeping —
skip unless A is measurably too slow.

Use **Option A** for this ticket. Factor the check into a private method
`checkUniqueConstraints(newRow, oldRow | null, onConflict) : Promise<UpdateResult | null>`
on `StoreTable`, called from all three insert/update branches.

### Transaction behavior

- The check must read through the transaction coordinator's pending writes
  where applicable, so a conflict inserted earlier in the same transaction is
  detected. See `TransactionCoordinator` in `packages/quereus-store/src/common/transaction.ts`
  for how pending puts/deletes overlay the base store (ties into the
  transaction-isolation ticket; at minimum the check must not miss pending
  writes in the same connection).
- On a failed check, no data-store or event-queue mutation should occur. Emit
  no events.

## Tests

Primary regression is `packages/quereus/test/logic/102-unique-constraints.sqllogic`
under `yarn test:store`. That file already covers:

- Basic UNIQUE rejection (lines 14–19)
- `INSERT OR IGNORE` (line 23)
- `INSERT OR REPLACE` (lines 29–35)
- Multiple NULLs permitted (lines 42–50)
- Duplicate non-NULL after NULLs (line 53)
- UPDATE to conflicting / own / new value (lines 67–93)
- Composite UNIQUE (lines 100–117)
- PK-change UPDATE with UNIQUE conflict (lines 124–142)

Optionally add a minimal spec in `packages/quereus-store/test/` exercising
`StoreTable.update` directly with a schema containing `uniqueConstraints`,
covering the insert path, the UPDATE same-PK path, and the NULL case — useful
to isolate from the full SQL pipeline.

## TODO

- Add `checkUniqueConstraints` helper on `StoreTable` that iterates
  `tableSchema.uniqueConstraints`, skips NULL-containing rows, and full-scans
  the data store for matching rows with a different PK.
- Wire the helper into the INSERT, same-PK UPDATE, and PK-change UPDATE
  branches of `StoreTable.update` (`store-table.ts:507/579/…`).
- Honor `onConflict` (IGNORE / REPLACE / default) for unique conflicts in all
  three branches, mirroring the existing PK-conflict handling.
- Ensure the check consults transaction-pending writes (read through
  coordinator) so intra-transaction duplicates are detected.
- Run `yarn test:store` and confirm `102-unique-constraints.sqllogic` passes;
  run `yarn test` to confirm no memory-mode regression.
- Run `yarn lint` in `packages/quereus-store`.
