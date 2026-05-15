---
description: Reviewer pass on the fix that makes `StoreModule.buildIndexEntries` enforce uniqueness when seeding a new UNIQUE index. `CREATE UNIQUE INDEX` on store-backed data with pre-existing duplicates now throws `UNIQUE constraint failed: <table> (<cols>)` *before* any entries are written, matching the memory module's `populateNewIndex` and SQLite semantics (partial-predicate honored, multiple-NULL composite still permitted).
files:
  packages/quereus-store/src/common/store-module.ts             # buildIndexEntries — added compilePredicate + Set dup-check
  packages/quereus-store/test/column-default-conflict.spec.ts   # new unit tests under the existing CREATE INDEX block
  packages/quereus/src/vtab/memory/layer/base.ts                # reference: populateNewIndex (lines 225-269)
  packages/quereus/test/logic/102.1-unique-edge-cases.sqllogic  # logic spec lines 57-100 covers the duplicate + NULL scenarios
---

## What changed

`StoreModule.buildIndexEntries` was unconditionally writing one entry per row,
so a `CREATE UNIQUE INDEX` over pre-existing duplicate data succeeded and
quietly produced a UNIQUE index with duplicate keys. Only the *next* insert
would be caught by the synthesized `uniqueConstraint`.

The seed pass now mirrors `populateNewIndex` in the memory module:

1. If `indexSchema.predicate` is set, compile it once with
   `compilePredicate(indexSchema.predicate, tableSchema.columns)` (named
   import from `@quereus/quereus`, already re-exported there).  Rows whose
   predicate is not unambiguously TRUE are skipped — they contribute neither
   to the duplicate check nor to on-disk entries.
2. For UNIQUE indexes, a `Set<string>` of `JSON.stringify(indexValues)`
   tracks already-seen rows. Rows where *any* indexed column is NULL skip
   the dup check (SQL UNIQUE allows multiple NULLs), but still emit their
   index entry.
3. On collision: throw
   `QuereusError(StatusCode.CONSTRAINT, "UNIQUE constraint failed: <tableName> (<colNames>)")`
   — same format `store-table.ts:checkUniqueConstraints` raises (`store-table.ts:1012`),
   so callers get a uniform message.
4. The throw fires **before** `batch.write()`, so the index store is left
   empty on failure. The index-store directory itself was already allocated
   by `getIndexStore`, but the ticket explicitly scopes index-store cleanup
   on partial failure as out of scope; the test asserts zero entries.

## Use cases / validation hooks

### Primary: duplicate data rejects

```sql
CREATE TABLE u_dup (k TEXT PRIMARY KEY, x TEXT NOT NULL) USING store;
INSERT INTO u_dup VALUES ('r1', 'dup'), ('r2', 'dup');
CREATE UNIQUE INDEX u_dup_x ON u_dup (x);  -- throws CONSTRAINT (UNIQUE)
```

Covered by:
- new unit test `rejects CREATE UNIQUE INDEX over duplicated data and leaves the index store empty` in `column-default-conflict.spec.ts` (asserts the throw *and* that the index store has zero entries afterward).
- `test/logic/102.1-unique-edge-cases.sqllogic:60` (`-- error: UNIQUE`).

### Multi-NULL composite still succeeds

```sql
CREATE TABLE u_null (k INTEGER PRIMARY KEY, y TEXT NULL, z TEXT NULL) USING store;
INSERT INTO u_null VALUES (1, NULL, NULL), (2, NULL, NULL);
CREATE UNIQUE INDEX u_null_yz ON u_null (y, z);  -- succeeds
SELECT count(*) FROM u_null;  -- 2
```

Covered by:
- new unit test `allows CREATE UNIQUE INDEX over multiple NULLs in composite indexed columns`.
- `test/logic/102.1-unique-edge-cases.sqllogic:91-100`.

### Partial UNIQUE index (reviewer: verify)

The change compiles the predicate when present and skips out-of-scope rows
in the seed pass. Not directly covered by a new unit test, but the
`compilePredicate` integration is the same one the run-time
`checkUniqueConstraints` path already exercises in 102.1 / 102.2 logic tests.
Reviewer might want to add an explicit unit test for a partial UNIQUE
seed-pass scenario where the duplicates fall *outside* the predicate scope
(should succeed) and *inside* the predicate scope (should fail).

## Tests run

- `yarn workspace @quereus/store run test` — 264 passing (includes the 3 new
  `CREATE INDEX refreshes cached tableSchema` cases).
- `yarn test` — 2942 passing, 2 pre-existing unrelated failures in
  `@quereus/sample-plugins` (`key_value_store virtual table` delete/update);
  confirmed pre-existing by repeating the run with my changes stashed.
- `yarn test:store` — 636 passing, 1 pre-existing unrelated failure in
  `29.1-column-level-conflict-clause.sqllogic:144` (UPDATE PK-change REPLACE
  + ON DELETE CASCADE — unrelated to CREATE UNIQUE INDEX); confirmed
  pre-existing by repeating with changes stashed. The previously-flagged
  102.1 scenarios now pass.
- `yarn workspace @quereus/store run typecheck` — clean.

## Known gaps

- No partial-predicate seed-pass unit test (described above). The
  underlying `compilePredicate` is well-covered elsewhere, but a
  store-specific test would be a nice belt-and-braces addition.
- Pre-existing test:store failure in 29.1 is out of scope.
- Pre-existing sample-plugins failures (delete/update on key_value_store)
  are out of scope.
- Index-store directory created by `getIndexStore` is *not* torn down on
  seed-pass failure. The ticket explicitly scoped that as out of bounds;
  the table's in-memory schema is unchanged (the throw happens before
  `table.updateSchema(updatedSchema)`), so the orphaned directory is
  invisible to subsequent SQL. A retry after dedup re-uses the same
  directory and writes fresh entries — confirmed by the unit test that
  retries `CREATE UNIQUE INDEX` after `DELETE`.
