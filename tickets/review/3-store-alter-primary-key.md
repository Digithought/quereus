description: Native ALTER PRIMARY KEY implemented in the store module via two-pass re-key + index rebuild.
dependencies: none
files:
  packages/quereus-store/src/common/store-table.ts        (new `rekeyRows` helper)
  packages/quereus-store/src/common/store-module.ts       (implemented `alterPrimaryKey` case)
  packages/quereus-store/test/alter-table.spec.ts         (new ALTER PK coverage)
  packages/quereus/test/logic.spec.ts                     (removed 41.1-alter-pk from store-mode skip list)
  packages/quereus/test/logic/41.1-alter-pk.sqllogic      (passes under store mode)
  packages/quereus/test/logic/50.1-declare-schema-pk.sqllogic (passes under store mode)
----

## Summary

Replaces the `UNSUPPORTED` throw in `StoreModule.alterTable`'s `alterPrimaryKey` arm with an in-place re-key.

### Data re-key (`StoreTable.rekeyRows`)

Two-pass over the data store:
1. **Validate**: stream every row, compute new PK bytes via `buildDataKey`, collect into `Map<hex(newKey), { newKey, oldKey, row }>`. On duplicate, throw `StatusCode.CONSTRAINT` — the store is never mutated, giving an all-or-nothing guarantee.
2. **Write**: one `store.batch()` that deletes the old key and puts the new (key, serialized row) pair for every row whose key changed. Rows whose key is unchanged are no-ops.

### Secondary index rebuild (module orchestration)

Index keys embed the PK suffix, so every secondary index must be rebuilt whenever the PK changes. For each index in the old schema:
- Open the index store and batch-delete every existing entry (iterate `buildFullScanBounds`).
- Re-populate via existing `StoreModule.buildIndexEntries(dataStore, indexStore, updatedSchema, indexSchema)` against the now-rekeyed data store.

This is a full clear + rebuild — O(n) but trivially correct.

### Schema + catalog update

After the data/index mutations succeed: `table.updateSchema`, `saveTableDDL`, emit `alter` schema change event — identical to the existing `addColumn`/`dropColumn` arms.

## Semantics enforced

- Column layout is unchanged — only `primaryKeyDefinition` is replaced.
- Runtime layer (`runAlterPrimaryKey`) has already validated NOT NULL, duplicate-column, and column-existence; the store trusts that shape.
- **Uniqueness of the resulting keys** is enforced in the validation pass (can fail even on valid input if two existing rows collide under the new PK).
- Row count is preserved across re-key, so `cachedStats` is left alone.

## Transactional semantics

Matches the existing `addColumn` / `dropColumn` convention: writes go directly through `store.batch()`, *not* through `TransactionCoordinator`. The validation-first structure means a `CONSTRAINT` failure leaves the store pristine. A crash mid-batch leaves the store in an inconsistent state — same exposure as existing ALTER paths, out of scope here.

## Test coverage

### Unit (`packages/quereus-store/test/alter-table.spec.ts`)
- Empty-table re-key, then insert under new PK and point-lookup.
- Populated-table re-key: row count preserved, point-lookup under new PK returns correct row.
- Duplicate-on-rekey: `CONSTRAINT` thrown, count + original PK lookup still work (store unchanged).
- Re-key with an existing secondary index: post-alter query by the indexed column returns correct result.

### Logic
- `41.1-alter-pk.sqllogic` — removed from `MEMORY_ONLY_FILES` skip list; passes under `QUEREUS_TEST_STORE=true`. Covers empty-rekey, populated rekey, duplicate rejection + unchanged-table verification, empty-PK, NOT NULL enforcement, DESC direction, composite PK, nonexistent column, duplicate column, nullable-column regression, parser round-trip.
- `50.1-declare-schema-pk.sqllogic` — was never in the skip list; now passes under store mode (was failing due to the same underlying missing native rekey).

### Guard
- `yarn test` (memory mode) — all pass, unchanged.
- `yarn test:store` — only pre-existing unrelated failure remains (`50-declarative-schema.sqllogic` — multi-candidate connection issue, not rekey-related; confirmed identical on pristine main).

## Use cases

- `alter table t alter primary key (col)` against a store-backed (persistent) table now rewrites the physical layout natively rather than falling back to the shadow-table rebuild in `runAlterPrimaryKey`.
- Declarative schema (`apply schema`) diffs that include `ALTER PRIMARY KEY` now land directly in the store module — also covers the `re-key + drop old PK column` and pure reorder cases (tested in 50.1).

## Follow-up (flagged, not done)

`runAlterPrimaryKey` in `packages/quereus/src/runtime/emit/alter-table.ts:380-386` catches `e instanceof QuereusError && e.code === StatusCode.UNSUPPORTED`. The `instanceof` check can fail under the test harness when the engine runs through ts-node while the store dist imports the compiled engine (two distinct `QuereusError` classes). Harden to `e?.code === StatusCode.UNSUPPORTED`. The native path makes this moot for ALTER PK specifically, but any future module-level UNSUPPORTED for other `alterTable` variants would hit the same invisible-fallback issue.
