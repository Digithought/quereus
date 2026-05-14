---
description: After `CREATE INDEX` on a `USING store` table, the connected `StoreTable`'s cached `tableSchema.indexes` is now refreshed so subsequent INSERT/UPDATE/DELETE correctly maintain the new index entries via `updateSecondaryIndexes`.
files:
  packages/quereus-store/src/common/store-module.ts
  packages/quereus-store/test/column-default-conflict.spec.ts
---

## What changed

### Fix (`packages/quereus-store/src/common/store-module.ts:308-348`)

`StoreModule.createIndex` now refreshes the connected `StoreTable`'s cached
schema after `buildIndexEntries` and before emitting the schema-change event.
This mirrors the pattern already used by every branch of `alterTable`
(`store-module.ts:443,498,539,579,663`):

```ts
const updatedIndexes = Object.freeze([
    ...(tableSchema.indexes ?? []),
    indexSchema,
]);
const updatedSchema: TableSchema = { ...tableSchema, indexes: updatedIndexes };
table.updateSchema(updatedSchema);
```

The engine-side `SchemaManager.createIndex` (in `packages/quereus`) was already
calling `schema.addTable(updatedTableSchema)` to update the engine's registry —
the only missing piece was that the `StoreTable` instance held its own
`tableSchema` reference (captured at connect-time in `store-table.ts:153`) and
its `updateSecondaryIndexes` loop iterates `this.tableSchema.indexes`. Without
this fix the cached reference stayed stale for the lifetime of the connected
table.

Per the implement-ticket plan: did not call `saveTableDDL` here — that path
generates only the `CREATE TABLE` text, and secondary-index persistence across
restarts is owned by a separate `CREATE INDEX` catalog entry path that is
out of scope here. `pkDirections` was not recomputed because
`primaryKeyDefinition` is unchanged.

### Regression test (`packages/quereus-store/test/column-default-conflict.spec.ts`)

Added `describe('CREATE INDEX refreshes cached tableSchema')` with one case,
`maintains the new index on inserts and updates issued after CREATE INDEX`,
that:

1. Creates a `USING store` table, inserts one pre-existing row, creates an
   index, then sanity-checks the index store has 1 entry from `buildIndexEntries`.
2. Inserts two new rows post-CREATE-INDEX and asserts the index store has 3 entries.
3. Updates the indexed column on one row and asserts count is still 3 (one entry
   moved: delete-old + put-new).
4. Deletes one row and asserts count is 2.

The earlier single-count-at-end shape (suggested in the ticket sketch) was
insufficient — it happened to produce `1` both with and without the fix because
the original pre-CREATE-INDEX row's entry survived. Splitting the assertions
across the lifecycle exposes the bug: without the fix, step 2 sees `1`
(no INSERT writes to the index because `tableSchema.indexes` is empty) and the
test fails with `expected 1 to equal 3`. Confirmed by stashing the fix and
re-running.

`buildFullScanBounds` from `../src/common/key-builder.js` is used (the
`InMemoryKVStore.iterate` signature accepts `{}`/undefined too, but
`buildFullScanBounds()` matches how production code scans index stores).

## Validation done

- `yarn workspace @quereus/store test` (full quereus-store spec suite): **260
  passing**, 0 failing.
- Verified the new test **fails on the unmodified code** (with the fix stashed
  out) with the expected mismatch (`AssertionError: expected 1 to equal 3` at
  the post-CREATE-INDEX INSERT count step). With the fix applied it passes.
- `yarn test` (root, all engine packages): all packages pass **except the same
  2 pre-existing failures** in `@quereus/sample-plugins`
  (`Comprehensive Demo Plugin > key_value_store virtual table > supports
  delete` and `... supports update`). Confirmed pre-existing on `main` by
  stashing the fix and re-running `yarn workspace @quereus/sample-plugins test`
  — same 2 failures, unrelated to `StoreModule.createIndex` (they target the
  `key_value_store` virtual table, not `USING store`).
- `yarn workspace @quereus/quereus run lint` — clean (exit 0, silent).
- `yarn workspace @quereus/store run typecheck` — clean.
- **Not run:** `yarn test:store` (LevelDB-backed logic tests). The fix is
  in-memory state on the `StoreTable` instance and the regression test directly
  inspects the index store via the in-memory provider; the logic-test path
  would not add coverage and is slow.

## Use cases / validation suggestions for the reviewer

- **Happy path covered:** `CREATE INDEX` followed by INSERT, UPDATE on indexed
  column, DELETE — all maintain the new index correctly.
- **Worth probing:** the `INSERT INTO ... ON CONFLICT REPLACE` path that
  routes through the secondary-index check. With the fix, replacement on a
  newly-created UNIQUE index should now both detect the conflict and update the
  index entries. The existing `INSERT with UNIQUE ON CONFLICT REPLACE` test
  uses a UNIQUE column declared at CREATE TABLE time (so the index is in the
  schema from the start) — does **not** exercise CREATE-INDEX-then-INSERT
  through the conflict path. Not added here because the bug was specifically
  about cache invalidation, not the conflict surface — but a reviewer might
  want one more case.
- **Worth probing:** `DROP INDEX`. Symmetric path (`SchemaManager.dropIndex`)
  may have the same stale-cache issue — not investigated as part of this
  ticket; if it exists, file a separate fix.
- **Persistence across restarts:** intentionally out of scope. If you
  re-connect a store-backed table and the catalog rehydration path doesn't
  re-register secondary indexes, that's a different (out-of-scope) bug — see
  the implement ticket's "Notes" section. The fix here is purely in-memory
  consistency for the lifetime of a connected `StoreTable`.

## Known gaps / things the reviewer should look at

- **Single test case.** Only one test was added (per the ticket sketch). The
  fix is narrow (one `updateSchema` call) and well-covered by the existing
  ALTER TABLE tests' pattern, but a reviewer who wants belt-and-suspenders may
  want to add: (a) CREATE INDEX on a non-empty table where the indexed column
  has NULL values, (b) CREATE INDEX with DESC on a composite key, (c) the
  CONFLICT-REPLACE-through-new-index case mentioned above.
- **The freeze + spread pattern** for `updatedIndexes` matches `alterTable`'s
  `dropColumn` branch at `store-module.ts:487`. The `Object.freeze` is
  defensive — the engine treats `TableSchema` as immutable but does not enforce
  it at the type level; downstream code mutating `indexes` would be a bug.
  Reviewer may want to drop the freeze if it's not load-bearing in the rest of
  the package, but the existing convention says keep it.
- **Related ticket: `store-table-pk-change-update-leaks-moved-row-index`.**
  Per the discovering ticket (the prior review-pass), the PK-change UPDATE
  path mis-constructs the old-key for `updateSecondaryIndexes` (uses `newPk`
  for both old and new). With this fix landed, that bug becomes observable at
  the index-store level (it was previously masked because no inserts after
  CREATE INDEX touched the index). **Not fixed here.** The regression test
  added in this ticket does not currently UPDATE the PK, so it does not trip
  the leak. If the reviewer wants the leak ticket to become testable, add an
  `UPDATE t SET id = ... WHERE id = ...` step and assert the index store no
  longer has the stale `(b, oldPk)` entry.

## Pre-existing bugs surfaced but **not** addressed

- The 2 `@quereus/sample-plugins` failures are pre-existing and orthogonal —
  the `key_value_store` virtual table is its own VTab module, not a
  `StoreModule`-based one. Out of scope.

## Notes for review

- The fix is a 4-line addition between `buildIndexEntries` and the schema-
  change emit. Easy to review in isolation.
- The schema-change event still fires with the same payload — only the
  in-memory `StoreTable.tableSchema` reference changes between
  `buildIndexEntries` returning and the event firing. Order matters: any
  observer that reacts to `create > index` and probes the table will now see
  a consistent schema.
- No documentation updates needed — `docs/architecture.md` and `docs/schema.md`
  describe the engine-side schema lifecycle, not the StoreTable's local cache
  shape, which is an implementation detail.
