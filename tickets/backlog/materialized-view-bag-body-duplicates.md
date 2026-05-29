description: A materialized view whose body has no inferable key (a "bag" — e.g. `select status from orders`) materializes on an all-columns primary key. If the body emits duplicate rows, create/refresh fails with a raw `UNIQUE constraint failed` error from the backing memory table. Define and implement acceptable v1 semantics for duplicate-bag bodies.
prereq:
files: packages/quereus/src/runtime/emit/materialized-view-helpers.ts, packages/quereus/src/runtime/emit/materialized-view.ts, packages/quereus/src/vtab/memory/layer/manager.ts
----

## Problem

Materialized views are modeled as *keyed derived relations*. The backing table's
primary key is derived from `keysOf` on the optimized body; when the body has no
usable key, `deriveBackingShape` falls back to an **all-columns** primary key.

Consequence: a perfectly ordinary bag-producing body that yields duplicate rows
cannot be materialized. For example:

```sql
create materialized view mv as select status from orders;  -- many rows share a status
```

`MemoryTableManager.replaceBaseLayer` inserts each row into a fresh `BaseLayer`
and throws on the first duplicate primary key:

```
UNIQUE constraint failed: sqlite_mv_mv PK.
```

The create (or a later `refresh materialized view`) then fails. The error is
technically correct but:
- it's confusing (it names the hidden backing table, not the MV);
- it makes a common, intuitive MV definition simply unusable;
- the failure mode is "loud at create" for create, but a body that *starts*
  duplicate-free and *becomes* duplicate-producing after source edits will fail
  only at the next `refresh` — surprising.

## Desired behavior (to be decided)

Pick and specify one of:

1. **Clear diagnostic + documented constraint.** Detect the duplicate at
   create/refresh and raise a purpose-built error naming the materialized view
   and explaining that a v1 materialized view requires a body with a unique key
   (suggest adding a key/`distinct`/aggregation). Lowest effort; keeps the
   "keyed derived relation" model honest.

2. **Synthetic row identity.** Give the backing table a synthetic monotonic row
   key so bag bodies with duplicates materialize faithfully (set semantics
   abandoned for bag semantics). Interacts with the Phase-2 incremental design,
   which addresses backing rows by `MaterializedViewSchema.primaryKey` — needs
   to be reconciled there.

3. **Explicit de-dup.** Define materialized views as set-valued and silently
   de-duplicate. Likely surprising; least preferred.

## Notes
- Current v1 behavior is flagged but not specified; this ticket exists to choose
  the semantics rather than leave the raw constraint error as the contract.
- Surfaced during review of `materialized-view-core`. Not blocking that ticket —
  keyed bodies work correctly and the failure is loud, not silent corruption.
