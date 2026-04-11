description: Added edge-case sqllogic tests for under-covered runtime emitters and DDL paths
dependencies: none
files:
  packages/quereus/test/logic/91-merge-join-edge-cases.sqllogic
  packages/quereus/test/logic/92-hash-aggregate-edge-cases.sqllogic
  packages/quereus/test/logic/93-ddl-view-edge-cases.sqllogic
  packages/quereus/test/logic/94-tvf-edge-cases.sqllogic
  packages/quereus/test/logic/94.1-limit-offset-edge-cases.sqllogic
  packages/quereus/test/logic/96-subquery-edge-cases.sqllogic
  packages/quereus/src/runtime/emit/create-view.ts
  packages/quereus/src/runtime/emit/drop-view.ts
  packages/quereus/src/runtime/emit/hash-aggregate.ts
  packages/quereus/src/runtime/emit/limit-offset.ts
  packages/quereus/src/runtime/emit/subquery.ts
  packages/quereus/src/runtime/emit/cast.ts
  packages/quereus/src/runtime/emit/table-valued-function.ts
  packages/quereus/src/runtime/emit/add-constraint.ts
----
## What was built

Six new `.sqllogic` test files targeting under-covered runtime emitter branches:

1. **91-merge-join-edge-cases** — Self-joins, residual conditions (equi + inequality), all-NULL keys, many-to-many cardinality, empty sides (both), multi-column join keys, mixed NULL/non-NULL keys with LEFT JOIN padding
2. **92-hash-aggregate-edge-cases** — Empty GROUP BY (empty result vs single row), NULL-only group keys, SUM/AVG/COUNT(DISTINCT) with NULLs, multiple DISTINCT aggregates, GROUP BY on expressions, single-row groups, all-NULL columns, HAVING filtering all groups, multi-column GROUP BY with NULLs, group_concat(DISTINCT)
3. **93-ddl-view-edge-cases** — CREATE VIEW IF NOT EXISTS (exists→no-op, new→create), DROP VIEW IF EXISTS (exists→drop, missing→no-op), error on duplicate CREATE, error on missing DROP, drop-and-recreate cycle. Also: ALTER TABLE ADD CONSTRAINT with named CHECK, NULL passing CHECK, multiple constraints on same table
4. **94-tvf-edge-cases** — json_each on empty array/object, single elements, null/boolean/mixed types, nested containers (no recursion), root path, subquery context, WHERE filtering, aggregation over TVF, LIMIT on TVF
5. **94.1-limit-offset-edge-cases** — LIMIT 0, negative LIMIT/OFFSET (→ treated as 0), OFFSET beyond count, empty table, MySQL `LIMIT y, x` syntax, LIMIT in subqueries. Also includes CAST fallback tests (null→null, 'abc'→INTEGER=0, 'xyz'→REAL=0, number→TEXT)
6. **96-subquery-edge-cases** — IN value list with NULL condition/values (three-valued logic), IN subquery with NULLs, EXISTS on empty/non-empty, scalar subquery 0-row→null/1-row-null→null/multi-row→error, 3-level nested correlated subqueries, correlated in HAVING, NOT IN with NULLs (classic SQL gotcha), column IN constant list with NULL semantics

## Coverage results

| File | Before (branch) | After (branch) | Delta |
|------|-----------------|----------------|-------|
| create-view.ts | 28% | **90%** | +62% |
| drop-view.ts | 22% | **77%** | +55% |
| limit-offset.ts | 50% | **62%** | +12% |
| cast.ts | — | **69%** | new |
| hash-aggregate.ts | 69% | 69% | ~0 |
| subquery.ts | 85% | 86% | ~+1% |
| **Overall emit/** | **82%** | **83.3%** | **+1.3%** |

### Files with minimal improvement (and root causes)

- **merge-join.ts** (0 funcs): Optimizer always prefers hash join. The `mergeJoinCost` formula wins when both inputs are pre-sorted, but `isOrderedOnEquiPairs()` rarely detects ordering from the planner. Fixing this requires optimizer changes, not test changes.
- **sequencing.ts** (0 funcs): `shouldUseSequencingNode()` detection exists but is a TODO — WindowNode is always used instead.
- **retrieve.ts** (0 funcs): Intentional error path — thrown when the optimizer fails to replace RetrieveNode with a physical access node.
- **add-constraint.ts** (33%): Uncovered branches (`type !== 'check'`, missing expr) are unreachable from the SQL parser.
- **hash-aggregate.ts** (69%): Remaining uncovered branches are the `sourceRelation !== plan.source` path for aggregates over JOINs — the representative source row lookup.
- **subquery.ts** (85%): Uncovered branches are the Promise-handling path in constant IN lists and the dynamic (non-constant) value list path.

## Testing

- All 1544 tests pass (0 failures)
- Lint: pre-existing issues only (no new warnings from sqllogic files)
- Test files follow existing conventions (table prefix per file, cleanup via DROP TABLE at end)
