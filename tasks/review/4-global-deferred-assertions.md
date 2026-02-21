---
description: Review global deferred assertions — plan caching, classification, error messages, tests
dependencies: Schema system, transaction infrastructure, optimizer, constraint-extractor

---

## Summary

Enhanced the existing global deferred assertion infrastructure with plan caching, improved classification, better error messages, and comprehensive test coverage.

### Changes Made

#### 1. Plan Caching & Schema Invalidation (`src/core/database-assertions.ts`)

- Added `CachedAssertionPlan` interface storing analyzed plan, classifications, relation mappings, pre-compiled row-specific artifacts (instruction + scheduler), and schema generation counter
- Added `cache` map and `schemaGeneration` counter to `AssertionEvaluator`
- Subscribed to `SchemaChangeNotifier` — bumps generation on `table_added`, `table_removed`, `table_modified` events
- Added `getOrCompilePlan()` — compiles on cache miss or stale generation; pre-compiles row-specific schedulers for reuse
- Added `invalidateAssertion()` — removes cache entry on DROP ASSERTION
- Wired `invalidateAssertionCache()` on `Database` class (called from `emitDropAssertion`)

#### 2. Classification Improvements (`src/planner/analysis/constraint-extractor.ts`)

Post-processing pass in `analyzeRowSpecific()` that walks the plan tree for identity-breaking nodes:

- `demoteForAggregate()` — checks if GROUP BY covers a unique key; demotes to 'global' if not
- `demoteAllBeneath()` — for `SetOperationNode` and `WindowNode`, demotes all table references beneath to 'global'
- `collectRelationKeysBeneath()` — helper to find all `TableReferenceNode` relationKeys below a node

#### 3. Error Message Enhancement (`src/core/database-assertions.ts`)

- `executeViolationOnce()` collects up to 5 violating rows before throwing
- `buildViolationError()` formats error with sample violation data
- Error messages now include the violating key tuples for debugging

#### 4. Drop Assertion Cache Invalidation (`src/runtime/emit/drop-assertion.ts`)

- Added `rctx.db.invalidateAssertionCache(plan.name)` call after removing assertion from schema

### Testing

Comprehensive test suite at `test/logic/95-assertions.sqllogic` (13 test sections):

1. **Basic DDL Round-Trip** — CREATE/DROP ASSERTION, verify data persists
2. **Assertion Violation at COMMIT** — always-failing assertion blocks commit
3. **Single-Table CHECK-like** — `NOT EXISTS(SELECT 1 FROM t WHERE balance < 0)`
4. **Multi-Table FK-like** — every child must reference existing parent
5. **Aggregate-Based Global** — `(SELECT COUNT(*) FROM items) <= 3`
6. **Rollback Clears Violations** — ROLLBACK before COMMIT avoids assertion check
7. **Savepoint Interaction** — ROLLBACK TO SAVEPOINT removes violating rows, COMMIT succeeds
8. **DROP ASSERTION IF EXISTS** — error without IF EXISTS, no error with
9. **Duplicate CREATE ASSERTION** — error on name collision
10. **Autocommit Mode** — assertions enforced on implicit commit
11. **Unrelated Table Optimization** — changes to non-dependent tables skip assertion
12. **Explain Assertion Diagnostics** — `explain_assertion()` classification verification
13. **Multiple Assertions** — two assertions on same table, each independently enforced

### Validation

- All 664 tests passing (including 1 new assertion test file), 0 failures
- TypeScript compilation clean
- No regressions in existing test suite

### Key Files

| Component | Path |
|-----------|------|
| Assertion evaluator | `packages/quereus/src/core/database-assertions.ts` |
| Database (cache API) | `packages/quereus/src/core/database.ts` |
| Constraint extractor | `packages/quereus/src/planner/analysis/constraint-extractor.ts` |
| Drop assertion emitter | `packages/quereus/src/runtime/emit/drop-assertion.ts` |
| Test suite | `packages/quereus/test/logic/95-assertions.sqllogic` |
