---
description: `CREATE UNIQUE INDEX` on a store-mode table with existing duplicate values silently succeeds — `StoreModule.buildIndexEntries` writes index entries without checking for duplicates. Subsequent inserts of a new duplicate correctly fail (derived `uniqueConstraint` is in place), but the existing duplicate rows are left in violation. Test fixture `102.1-unique-edge-cases.sqllogic:60` exercises this; it became reachable after `store-checkuniqueconstraints-honor-partial-predicate` and is now the only failure in `yarn test:store`.
files:
  packages/quereus-store/src/common/store-module.ts          # buildIndexEntries — needs a uniqueness check for indexSchema.unique
  packages/quereus/src/vtab/memory/manager.ts                # reference: MemoryTableModule.createIndex validates uniqueness during seeding
  packages/quereus/test/logic/102.1-unique-edge-cases.sqllogic   # the failing scenario at line 60
---

## Reproduction

```sql
create table u2_a (k text primary key, x text not null);
insert into u2_a values ('r1', 'dup'), ('r2', 'dup');
create unique index u2_a_x on u2_a(x);
-- expected: UNIQUE constraint failed (some flavor)
-- actual (store mode): silently succeeds; the duplicate 'dup' rows now both
-- live in the table with a "unique" index that contains duplicate keys.
```

In memory mode this same statement raises `UNIQUE constraint failed` (verified
on baseline; the same test file passes the memory-mode run). The asymmetry
sits in the store-mode createIndex path.

## Background

`SchemaManager.createIndex` (`packages/quereus/src/schema/manager.ts:1152`)
delegates to `tableSchema.vtabModule.createIndex(...)`. For store-backed
tables, that resolves through `IsolationModule.createIndex`
(`packages/quereus-isolation/src/isolation-module.ts:306`) →
`StoreModule.createIndex`
(`packages/quereus-store/src/common/store-module.ts:308`) →
`StoreModule.buildIndexEntries`
(`packages/quereus-store/src/common/store-module.ts:372`).

`buildIndexEntries` scans the data store and writes one index entry per row,
unconditionally — it never checks whether `indexSchema.unique` is set and
whether two rows would hash to the same index key.

## Expected behavior

`CREATE UNIQUE INDEX` on a table whose existing rows would violate the new
uniqueness must fail with a constraint error and leave the table state
unchanged (no half-built index, no derived `uniqueConstraint` in the schema).
Mirrors SQLite and Quereus memory-mode behavior.

For partial UNIQUE indexes (`CREATE UNIQUE INDEX ... WHERE ...`), only rows
satisfying the predicate participate — the validation pass needs to honor the
predicate the same way the run-time check does (see how
`MemoryTableManager.createIndex` interacts with the partial-predicate
compiler from `vtab/memory/utils/predicate.ts`).

## Suggested implementation shape

In `buildIndexEntries`, when `indexSchema.unique` is set:

- Maintain a `Map<hex(indexKey), Row>` (or a `Set<hex>`) keyed on the encoded
  index key (without the PK suffix, since the suffix is what makes
  non-unique index entries distinct).
- For each row, compute the unique-portion key; if already present, throw a
  `QuereusError(StatusCode.CONSTRAINT, "UNIQUE constraint failed: ...")` —
  match the message the run-time path produces (`<schema>.<table>
  (<colNames>)`) so the test's `error: UNIQUE` substring matches uniformly.
- For partial UNIQUE indexes, evaluate `compilePredicate(indexSchema.predicate,
  tableSchema.columns)` once and skip rows where `evaluate(row) !== true`.
- NULL semantics: a row with NULL in any of the index columns does not
  participate in uniqueness (matches the run-time `checkUniqueConstraints`
  fast-path); skip it.

If the seed pass detects a violation, abort before writing any index entries
and before `StoreModule.createIndex` calls `table.updateSchema(updatedSchema)`
— otherwise the table ends up with a half-populated index store and a UC
in its cached schema referring to a constraint already in violation.

The reference implementation is in
`packages/quereus/src/vtab/memory/manager.ts` — search for `createIndex`
and follow the seeding loop; it already does the equivalent for the
in-memory BTree.

## Out of scope

- Index-store cleanup on partial failure beyond the current scope (the seed
  pass should detect the violation before writing any entries; a partial-write
  recovery path is unnecessary).
- The `-- run` markers at 102.1 line 73-87 are a separate scenario (mid-txn
  schema change) and already work — the seeding validation should be enough
  to make all of 102.1 pass.
