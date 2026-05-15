---
description: Make `StoreModule.buildIndexEntries` enforce uniqueness when seeding a new UNIQUE index: detect duplicate index keys (honoring partial predicates and SQL NULL semantics) and throw `CONSTRAINT` before writing any entries, so `CREATE UNIQUE INDEX` over already-duplicated data fails atomically and matches memory-mode / SQLite behavior.
files:
  packages/quereus-store/src/common/store-module.ts             # buildIndexEntries — add the uniqueness check
  packages/quereus/src/vtab/memory/layer/base.ts                # reference: populateNewIndex (lines 225-265)
  packages/quereus/src/vtab/memory/utils/predicate.ts           # compilePredicate — exported from @quereus/quereus as `compilePredicate`
  packages/quereus-store/src/common/store-table.ts              # runtime error format: `UNIQUE constraint failed: <table> (<cols>)`
  packages/quereus/test/logic/102.1-unique-edge-cases.sqllogic  # failing scenario at line 60 + nullable scenario at line 91
---

## Goal

`CREATE UNIQUE INDEX` on a store-backed table whose existing rows would
violate the new uniqueness must raise `UNIQUE constraint failed` and leave
the table state unchanged.  Currently `StoreModule.buildIndexEntries`
unconditionally writes one entry per row, so the seed pass silently produces
an index with duplicate keys; only the next *new* insert is caught by the
derived run-time `uniqueConstraint`.  The fix is to mirror the memory
module's `populateNewIndex` (`packages/quereus/src/vtab/memory/layer/base.ts:225-265`):
detect the duplicate during seeding and throw before any batch write.

## Design

In `StoreModule.buildIndexEntries`
(`packages/quereus-store/src/common/store-module.ts:372`):

1. **Partial predicate.**  If `indexSchema.predicate` is present, compile it
   once via `compilePredicate(indexSchema.predicate, tableSchema.columns)`
   (imported from `@quereus/quereus`).  For each row, skip when
   `predicate.evaluate(row) !== true` — same partial-index semantics the
   run-time path uses.  Rows outside the predicate scope must not contribute
   to either the duplicate check or the on-disk index entries.

2. **Uniqueness pass.**  When `indexSchema.unique`, maintain a
   `Set<string>` keyed by a stable encoding of the index column values
   (`JSON.stringify(colsArray)` — same approach `populateNewIndex` uses).
   Encoding off the raw `SqlValue[]` matches the in-memory reference
   implementation; using the full `buildIndexKey` output is unnecessary
   since the PK suffix is what distinguishes non-unique entries — we want to
   detect collisions on the *unique* portion.

3. **NULL semantics.**  Skip the duplicate check (but still emit the index
   entry) when any column in `indexSchema.columns` is `null` for the row.
   Mirrors `populateNewIndex` and the run-time `checkUniqueConstraints`
   fast-path that allows multiple NULLs.  This is what makes the
   `create unique index u2_c_yz on u2_c(y, z)` scenario at
   `102.1-unique-edge-cases.sqllogic:95` (two rows with `(null, null)`)
   continue to succeed.

4. **Error.**  On collision, raise
   `QuereusError(StatusCode.CONSTRAINT, "UNIQUE constraint failed: <schemaName>.<tableName> (<colNames>)")`.
   Match the run-time path's message format (`store-table.ts` line ~1010 —
   `\`UNIQUE constraint failed: ${schema.name} (${colNames})\``) so callers
   see a uniform message.  Column names come from
   `indexSchema.columns.map(c => tableSchema.columns[c.index].name)`.
   The sqllogic harness matches on the substring `UNIQUE`, but the
   user-visible format should still mirror the run-time path.

5. **Atomicity.**  Throw *before* `await batch.write()` so the index store
   stays empty if the seed pass detects a violation.  The outer
   `StoreModule.createIndex` already propagates the throw before
   `table.updateSchema(updatedSchema)` runs, so the in-memory table schema
   is unchanged.  The index store directory itself was created by
   `getIndexStore` but contains no entries — acceptable per the ticket
   ("Index-store cleanup on partial failure beyond the current scope").

## Sketch

```typescript
import { compilePredicate, type CompiledPredicate } from '@quereus/quereus';
// ... (already imports QuereusError, StatusCode)

private async buildIndexEntries(
    dataStore: KVStore,
    indexStore: KVStore,
    tableSchema: TableSchema,
    indexSchema: TableIndexSchema
): Promise<void> {
    const encodeOptions = { collation: 'NOCASE' as const };
    const pkDirections = tableSchema.primaryKeyDefinition.map(pk => !!pk.desc);
    const indexDirections = indexSchema.columns.map(col => !!col.desc);

    const predicate: CompiledPredicate | undefined =
        indexSchema.predicate
            ? compilePredicate(indexSchema.predicate, tableSchema.columns)
            : undefined;
    const seen: Set<string> | undefined =
        indexSchema.unique ? new Set() : undefined;

    const bounds = buildFullScanBounds();
    const batch = indexStore.batch();

    for await (const entry of dataStore.iterate(bounds)) {
        const row = deserializeRow(entry.value);

        if (predicate && predicate.evaluate(row) !== true) continue;

        const pkValues = tableSchema.primaryKeyDefinition.map(pk => row[pk.index]);
        const indexValues = indexSchema.columns.map(col => row[col.index]);

        if (seen) {
            const hasNull = indexValues.some(v => v === null);
            if (!hasNull) {
                const sig = JSON.stringify(indexValues);
                if (seen.has(sig)) {
                    const colNames = indexSchema.columns
                        .map(c => tableSchema.columns[c.index].name)
                        .join(', ');
                    throw new QuereusError(
                        `UNIQUE constraint failed: ${tableSchema.name} (${colNames})`,
                        StatusCode.CONSTRAINT,
                    );
                }
                seen.add(sig);
            }
        }

        const indexKey = buildIndexKey(
            indexValues, pkValues, encodeOptions, indexDirections, pkDirections,
        );
        batch.put(indexKey, new Uint8Array(0));
    }

    await batch.write();
}
```

## Validation

- `yarn test` — memory-mode logic still passes; the test file 102.1 already
  passes here, but ensure no regression in any of `test/logic/102.*`.
- `yarn test:store` — confirms the previously-failing scenario at
  `102.1-unique-edge-cases.sqllogic:60` now reports the error, *and* that
  the nullable scenario at line 91 (multi-NULL composite) still succeeds.
  Per the ticket, this is the only outstanding failure in `yarn test:store`.
- Lint the touched file: `yarn workspace @quereus/quereus-store run build`
  (no dedicated lint script on the store package).

## TODO

- Add the `compilePredicate` + `CompiledPredicate` imports to
  `packages/quereus-store/src/common/store-module.ts` (named imports from
  `@quereus/quereus`).
- Rewrite `buildIndexEntries` per the Sketch above: predicate compile,
  Set-based dup tracking, NULL skip, error matching run-time format, throw
  before `batch.write()`.
- Run `yarn test 2>&1 | tee /tmp/test.log; tail -n 80 /tmp/test.log` and
  confirm green.
- Run `yarn test:store 2>&1 | tee /tmp/test-store.log; tail -n 120 /tmp/test-store.log`
  and confirm 102.1 (and the rest) green.
- Add a focused unit test under `packages/quereus-store/test/` covering:
  CREATE UNIQUE INDEX on duplicated data fails with `UNIQUE` in the message
  AND the index store is empty afterward (no half-built entries).  Place it
  near `column-default-conflict.spec.ts` since that suite already exercises
  the CREATE INDEX schema-refresh path on store-backed tables.
