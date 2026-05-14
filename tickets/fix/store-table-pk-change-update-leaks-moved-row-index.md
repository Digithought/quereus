---
description: `StoreTable.update`'s PK-change branch calls `updateSecondaryIndexes(oldRow, coerced, newPk)` with `newPk` for both old and new index keys. The "delete old" step then constructs a key at `(oldRow_indexvals, newPk)` — but the actual index entry was at `(oldRow_indexvals, oldPk)`. So every PK-change UPDATE permanently leaks the moved row's old secondary-index entries.
prereq: store-table-create-index-schema-not-updated
files:
  packages/quereus-store/src/common/store-table.ts
---

## Repro (after the prereq fix lands)

```ts
db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, b INTEGER) USING store`);
db.exec(`CREATE INDEX t_b ON t (b)`);
db.exec(`INSERT INTO t VALUES (1, 100)`);
db.exec(`UPDATE t SET id = 5 WHERE id = 1`);
// Index store should have exactly one entry: (b=100, pk=5).
// Actually has two: (b=100, pk=1) [LEAKED] + (b=100, pk=5).
```

## Cause

`updateSecondaryIndexes` (packages/quereus-store/src/common/store-table.ts:853) takes a single `pk` parameter used for *both* the old and new index key construction. For PK-change UPDATE, the caller at line 780 passes `newPk` — correct for the new entry, but wrong for removing the old one (which is keyed by `oldPk`).

## Suggested approach

- Split into separate old-pk and new-pk parameters, or call the helper twice (once with `(oldRow, null, oldPk)`, once with `(null, coerced, newPk)`) for the PK-change case.
- Add a regression test mirroring the eviction-cleanup test in `column-default-conflict.spec.ts` once the prereq lets writes actually exercise indexes.

## Discovery context

Found while reviewing `tickets/review/store-table-update-column-default-conflict.md`. By inspection the code constructs `buildIndexKey(oldRow_indexvals, pk=newPk, …)` at line 870 even when called from a PK-change UPDATE.
