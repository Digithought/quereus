description: Enforce UNIQUE constraints in memory vtab INSERT/UPDATE paths
dependencies: none
files:
  packages/quereus/src/vtab/memory/layer/manager.ts (performInsert, performUpdate, unique constraint checking helpers, ensureUniqueConstraintIndexes)
  packages/quereus/src/vtab/memory/layer/base.ts (getSecondaryIndex accessor)
  packages/quereus/src/vtab/memory/layer/transaction.ts (getSecondaryIndex accessor)
  packages/quereus/src/vtab/memory/layer/interface.ts (getSecondaryIndex on Layer interface)
  packages/quereus/src/vtab/memory/index.ts (MemoryIndex - used for unique checking via getPrimaryKeys)
  packages/quereus/src/planner/type-utils.ts:38-43 (nullable UNIQUE no longer treated as key)
  packages/quereus/test/fuzz.spec.ts:863 (unskipped SELECT DISTINCT fuzz test)
----

## What Was Built

UNIQUE constraints on memory vtab tables are now enforced at mutation time, fixing a bug where duplicate values could be inserted into UNIQUE columns, which then caused `SELECT DISTINCT` to return duplicates (because the DISTINCT elimination optimizer trusted the UNIQUE metadata).

### Changes

1. **Auto-index creation for UNIQUE constraints** (`manager.ts:ensureUniqueConstraintIndexes`):
   Secondary indexes are auto-created for each UNIQUE constraint that doesn't already have a covering index. This mirrors standard SQL behavior and enables O(log n) constraint checking.

2. **UNIQUE enforcement in `performInsert`** (`manager.ts`):
   After PK uniqueness check, each UNIQUE constraint is validated against secondary indexes. NULL values in constrained columns are skipped per SQL semantics (UNIQUE allows multiple NULLs). Conflict resolution (IGNORE, REPLACE, ABORT) is handled consistently with PK conflict handling.

3. **UNIQUE enforcement in `performUpdate`** (`manager.ts`):
   - Same-PK updates: Only checks UNIQUE if constrained columns actually changed.
   - PK-change updates: Old row is deleted first, then UNIQUE is checked at the new position. On failure, the delete is rolled back.

4. **Defensive fix in `type-utils.ts`**: `relationTypeFromTableSchema` now only adds UNIQUE constraints to `keys[]` when all constrained columns are NOT NULL. A nullable UNIQUE column allows multiple NULLs, so it's not a true key for DISTINCT elimination.

5. **Layer interface** (`interface.ts`, `base.ts`, `transaction.ts`): Added `getSecondaryIndex()` method to expose `MemoryIndex` objects for efficient constraint checking.

6. **Fuzz test unskipped** (`fuzz.spec.ts`): `'SELECT DISTINCT results are unique'` test is now active.

## Key Testing Scenarios

- Insert duplicate values into UNIQUE column → ABORT returns constraint error
- Insert duplicate values with ON CONFLICT IGNORE → silently skipped
- Insert duplicate values with ON CONFLICT REPLACE → conflicting row deleted, new row inserted
- NULL values in UNIQUE columns → allowed (multiple NULLs are valid per SQL standard)
- UPDATE that changes UNIQUE column to conflicting value → constraint error
- UPDATE that doesn't change UNIQUE columns → no constraint check overhead
- PK-change UPDATE with UNIQUE conflict → old row restored on failure
- SELECT DISTINCT on UNIQUE NOT NULL column → correct deduplication (fuzz test)
- SELECT DISTINCT on UNIQUE nullable column → DISTINCT node preserved (not eliminated)
- Composite UNIQUE constraints → all columns checked together

## Test Results

- All 1723 quereus tests passing
- Full workspace test suite passing (no regressions)
- Fuzz test `'SELECT DISTINCT results are unique'` passes with property-based testing
