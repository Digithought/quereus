description: Add edge-case sqllogic tests for under-covered runtime emitters and DDL paths
dependencies: none
files:
  packages/quereus/src/runtime/emit/merge-join.ts
  packages/quereus/src/runtime/emit/sequencing.ts
  packages/quereus/src/runtime/emit/retrieve.ts
  packages/quereus/src/runtime/emit/drop-view.ts
  packages/quereus/src/runtime/emit/create-view.ts
  packages/quereus/src/runtime/emit/hash-aggregate.ts
  packages/quereus/src/runtime/emit/table-valued-function.ts
  packages/quereus/src/runtime/emit/add-constraint.ts
  packages/quereus/src/runtime/emit/schema-declarative.ts
  packages/quereus/src/runtime/emit/subquery.ts
  packages/quereus/src/runtime/emit/limit-offset.ts
  packages/quereus/src/runtime/emit/parameter.ts
  packages/quereus/src/runtime/emit/create-assertion.ts
  packages/quereus/src/runtime/emit/cast.ts
  packages/quereus/src/runtime/emit/scan.ts
  packages/quereus/src/runtime/emit/pragma.ts
  packages/quereus/test/logic/
----
The runtime emitter layer (`src/runtime/emit/`, 61 files) has 264 uncovered branches at 82% branch
coverage overall, but several critical emitters are far worse. These emitters translate PlanNodes
into executable Instructions — bugs here produce silent wrong results.

**Worst offenders by branch coverage:**

| File | Branches | Uncov | Risk |
|------|----------|-------|------|
| merge-join.ts | 100% (0 funcs!) | — | Entirely untested at runtime (17% stmts) — outer join NULL padding, duplicate-key runs |
| sequencing.ts | 100% (0 funcs!) | — | Untested (29% stmts) — row numbering for sequence columns |
| retrieve.ts | 100% (0 funcs!) | — | Untested (46% stmts) — error path when RetrieveNode not optimized away |
| drop-view.ts | 22% | 7 | IF EXISTS logic, transaction rollback on failure |
| create-view.ts | 28% | 5 | IF NOT EXISTS, schema capture edge cases |
| add-constraint.ts | 33% | 4 | Constraint addition error handling |
| hash-aggregate.ts | 69% | 24 | DISTINCT aggregates, NULL-only groups, empty groups, mixed types |
| table-valued-function.ts | 48% | 13 | Promise vs AsyncIterable unwrapping, error recovery |
| limit-offset.ts | 50% | 10 | OFFSET without LIMIT, LIMIT 0, negative values |
| subquery.ts | 85% | — | Correlated subquery edge cases (74% stmts) |
| schema-declarative.ts | 73% | — | Declarative schema diffing edge cases (77% stmts) |

**Test strategy:** New `.sqllogic` files — no scaffolding needed. Focus areas:

- **Merge join**: Self-joins, all-NULL join keys, empty table on either side, many-to-many cardinality, outer joins with NULLs
- **Hash aggregates**: NULL-only groups, empty input, `count(*)` vs `count(col)` with NULLs, `DISTINCT` inside aggregates, single-row groups, mixed-type grouping keys
- **DDL views**: `CREATE VIEW IF NOT EXISTS`, `DROP VIEW IF EXISTS`, drop nonexistent view (error), create duplicate view (error), view referencing dropped table
- **TVFs**: Error cases (missing function, wrong arg count, wrong types), TVFs returning empty results
- **Limit/offset**: `LIMIT 0`, `OFFSET` beyond row count, `OFFSET` without `LIMIT`, `LIMIT` on empty table
- **Subqueries**: Deeply nested correlated subqueries, correlated subquery in HAVING, scalar subquery returning multiple rows (error)
- **Constraints**: Adding constraints to tables with existing violating data, constraint on view (error)

TODO:
- Run `yarn test:coverage` and capture baseline branch counts for each target file
- Create `test/logic/91-merge-join-edge-cases.sqllogic` — merge join specific tests
- Create `test/logic/92-hash-aggregate-edge-cases.sqllogic` — aggregate edge cases
- Create `test/logic/93-ddl-view-edge-cases.sqllogic` — view DDL branches
- Create `test/logic/94-tvf-edge-cases.sqllogic` — table-valued function branches
- Create `test/logic/95-limit-offset-edge-cases.sqllogic` — boundary cases
- Create `test/logic/96-subquery-edge-cases.sqllogic` — correlated + scalar subquery edges
- Add constraint edge cases to existing `test/logic/90-error_paths.sqllogic` or new file
- Re-run coverage and verify branch improvements per file
