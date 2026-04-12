description: Enforce UNIQUE constraints in memory vtab INSERT/UPDATE paths
dependencies: none
files:
  packages/quereus/src/vtab/memory/layer/manager.ts (performInsert, performUpdate)
  packages/quereus/src/vtab/memory/layer/base.ts (secondary index infrastructure)
  packages/quereus/src/vtab/memory/index.ts (MemoryIndex - lookup/insert for unique checking)
  packages/quereus/src/schema/table.ts (UniqueConstraintSchema definition)
  packages/quereus/src/planner/rules/distinct/rule-distinct-elimination.ts (consumes key metadata)
  packages/quereus/src/planner/type-utils.ts:38-43 (converts uniqueConstraints to keys)
  packages/quereus/test/fuzz.spec.ts:870 (skipped test to unskip when fixed)
----

## Root Cause

`SELECT DISTINCT` returns duplicate rows because two bugs combine:

1. **UNIQUE constraints are completely unenforced** in the memory vtab mutation path.
   `performInsert()` and `performUpdate()` in `layer/manager.ts` only check primary key
   uniqueness (via `lookupEffectiveRow(primaryKey, ...)`). They never check
   `tableSchema.uniqueConstraints` at all. This means duplicate values can be inserted
   into columns declared with `UNIQUE`.

2. **DISTINCT elimination trusts UNIQUE metadata.** `ruleDistinctElimination` in
   `rule-distinct-elimination.ts` removes the DISTINCT plan node when the source reports
   keys (derived from UNIQUE constraints in `type-utils.ts:38-43`). Since UNIQUE isn't
   enforced, the optimizer removes DISTINCT from queries where duplicates actually exist.

The combination: duplicate values get inserted despite UNIQUE → optimizer removes DISTINCT
trusting UNIQUE → query output contains duplicates.

## Verified Reproduction

Counterexample from fuzz test (seed -1030173194):
```sql
create table t1 (c_blob0 blob unique, c_int1 integer primary key,
                  c_any2 any not null unique) using memory;
insert into t1 values (x'00', 1, 'a');
insert into t1 values (x'00', 2, 'b');  -- should fail UNIQUE, but succeeds
insert into t1 values (x'00', 3, 'c');  -- should fail UNIQUE, but succeeds
select distinct c_blob0 from t1;
-- Returns 3 rows (all x'00') instead of 1
```

Confirmed: DISTINCT BTree comparison itself works correctly (tested without UNIQUE
constraint). The bug is UNIQUE enforcement + DISTINCT elimination.

## Architecture

The memory vtab already has secondary index infrastructure:
- `MemoryIndex` class in `index.ts` — BTree-based, supports `addEntry()`, `getPrimaryKeys()`,
  and key lookup via `find()`/`get()`
- `BaseLayer.secondaryIndexes` in `layer/base.ts` — Map of index name → MemoryIndex
- Indexes are rebuilt on schema changes via `rebuildAllSecondaryIndexes()`
- The key comparison in MemoryIndex uses `createTypedComparator` which handles all SQL types
  correctly (including byte-wise Uint8Array comparison for blobs)

The secondary indexes exist for query optimization (index scans) but are NOT used for
mutation-time constraint checking.

## Fix

### Phase 1: Enforce UNIQUE in performInsert (primary fix)

In `layer/manager.ts:performInsert()`, after PK checking (line ~514), add UNIQUE constraint
checking:

- Get `schema.uniqueConstraints` from the table schema
- For each unique constraint, extract the constrained column values from the new row
- Look up those values in the appropriate secondary index
- If found AND the found row's PK differs from the new row's PK, it's a violation
- Handle conflict resolution (IGNORE, REPLACE) consistent with PK handling

The secondary indexes are maintained by the layer infrastructure and should already contain
current data. The constraint key needs to be built the same way the index keys are built
(using the index's `keyFromRow` function).

**Note**: The secondary indexes map index keys → primary keys. For unique checking, we need
to look up by the constraint columns and see if any existing row matches. The `MemoryIndex`
already supports this via `find()` or `get()`.

### Phase 2: Enforce UNIQUE in performUpdate

Similar to performInsert: when the new row changes a column covered by a UNIQUE constraint,
check that the new values don't conflict with any existing row (other than the row being
updated).

### Phase 3: Unskip the fuzz test

In `packages/quereus/test/fuzz.spec.ts:870`, change `it.skip(...)` to `it(...)` for
`'SELECT DISTINCT results are unique'`.

## TODO

### Phase 1
- [ ] In `performInsert()`, after PK uniqueness check, iterate `schema.uniqueConstraints` and check each constraint against secondary indexes
- [ ] Handle ConflictResolution (IGNORE, REPLACE) for UNIQUE violations, consistent with PK handling
- [ ] Handle the case where no secondary index exists for a unique constraint (may need to create one or do a scan)

### Phase 2
- [ ] In `performUpdate()`, check UNIQUE constraints when constrained columns change
- [ ] Skip check for the row being updated (same PK)

### Phase 3
- [ ] Unskip the fuzz test `'SELECT DISTINCT results are unique'` in `fuzz.spec.ts`
- [ ] Run the full fuzz test suite to verify the fix
- [ ] Run `yarn test` across the workspace to check for regressions
