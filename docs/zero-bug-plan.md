# Zero Bug Plan

Prioritized strategy for pushing Quereus test coverage toward zero bugs.

## 1. Coverage-Driven Targeting

Run `c8` to generate a branch coverage report and identify untested code paths:

```bash
yarn test:coverage
```

Focus on **branch coverage** over line coverage — uncovered branches in runtime emitters and planner analysis passes are where subtle bugs hide. Use the report to prioritize efforts below.

## 2. Edge-Case SQL Logic Tests for the Runtime Layer

The 61 runtime emitter files (`src/runtime/emit/`) are exercised almost entirely through integration-level sqllogic tests. Add focused `.sqllogic` files targeting edge cases in each subsystem:

- **Aggregates**: NULL-only groups, empty groups, mixed types, single-row groups, `count(*)` vs `count(col)` with NULLs, aggregate over zero rows
- **Joins**: empty table on either side, all-NULL join keys, self-joins with aliasing, joins producing zero rows, many-to-many cardinality explosions
- **Window functions**: empty partitions, single-row partitions, frame boundary edge cases (`ROWS BETWEEN 0 PRECEDING AND 0 FOLLOWING`), `RANGE` vs `ROWS` differences, NULLs in partition/order keys
- **Set operations**: empty inputs, all-duplicate inputs, type coercion across branches, mixed column types
- **Sorts**: stability with duplicate keys, NULL ordering (`NULLS FIRST`/`NULLS LAST`), multi-column sorts with mixed ASC/DESC
- **Constraints**: deferred check constraints referencing other tables, foreign key cascades during multi-row deletes, assertion evaluation at commit with complex state

New `.sqllogic` files are the most efficient vehicle here — no scaffolding needed.

## 3. Compositional Property-Based Tests

Extend `test/property.spec.ts` and `test/fuzz.spec.ts` beyond primitive-level properties to **query-level invariants**:

- **Algebraic identities**:
  - `count(*)` matches actual row count from iteration
  - `SELECT DISTINCT` results are actually distinct
  - `UNION` and `UNION ALL` differ only by duplicates
  - `A EXCEPT B` union `A INTERSECT B` = `A`
  - `A DIFF B` is empty iff `A` and `B` have identical contents
- **Aggregate consistency**: `sum(x)` equals the sum of individually selected `x` values
- **Window function correctness**: `sum(x) OVER (ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)` is a running sum; `row_number()` produces a contiguous 1..N sequence
- **Roundtrip properties**: INSERT then SELECT for all type combinations including edge values (empty strings, `MAX_SAFE_INTEGER` boundaries, empty blobs, null-heavy rows, temporal boundary values)
- **Optimizer equivalence** (differential testing against self): run queries with and without specific optimizer rules enabled and assert identical result sets — catches optimizer bugs that produce wrong results silently

## 4. Plan-Shape Tests for Optimizer Decisions

Add tests in `test/plan/` that assert specific optimizer decisions appear in the plan:

- Predicate pushed below join
- Index selected over scan when WHERE matches an index
- Bloom join chosen for large equi-joins
- Streaming aggregation selected when input is pre-sorted
- Subquery decorrelated into semi/anti join
- CTE materialized vs inlined based on reference count

These guard against optimizer regressions where queries still return correct results but via a worse plan.

## 5. Error Path Audit

`test/logic/90-error_paths.sqllogic` exists but likely doesn't cover all error conditions. Systematically verify:

- Every `QuereusError` status code is triggered by at least one test
- Parse errors include useful diagnostics (line/column)
- Constraint violations produce the correct error type and message
- Transaction error paths: commit after failed statement, nested savepoint rollback, rollback of already-rolled-back savepoint
- Type coercion errors at system boundaries

Approach: grep all `StatusCode` usages in `src/`, cross-reference with test expectations, and fill gaps with new sqllogic error tests.

## 6. Mutation Testing on Key Subsystems

Use [Stryker](https://stryker-mutator.io/) to systematically mutate source code and verify tests catch the mutations. A line being "covered" doesn't mean the test would fail if the line were wrong — mutation testing reveals superficial coverage.

Run subsystem-at-a-time to keep execution time manageable. Priority targets:

1. `src/planner/analysis/` — predicate analysis, constraint extraction, cardinality estimation
2. `src/runtime/emit/` — emitter correctness for each node type
3. `src/func/builtins/` — function edge-case handling
4. `src/vtab/memory/` — memory table index and scan logic

### Mutation Testing Session Results (2026-04-13)

Setup: Stryker (`@stryker-mutator/core` + mocha runner + typescript checker) configured in
`packages/quereus/stryker.config.mjs`. Run via `yarn mutation:subsystem <alias>` where aliases
are `analysis`, `emit`, `builtins`, `memory`.

**Baseline scores (before killing tests):**

| Subsystem | File | Score |
|-----------|------|-------|
| planner/analysis | predicate-normalizer.ts | 31.78% |
| planner/analysis | binding-collector.ts | 0.00% |
| planner/analysis | const-pass.ts | 64.65% |
| planner/analysis | const-evaluator.ts | 61.29% |
| planner/analysis | constraint-extractor.ts | 47.97% |
| planner/analysis | expression-fingerprint.ts | 83.33% |
| runtime/emit | sort.ts | 100% |
| runtime/emit | filter.ts | 94.44% |
| runtime/emit | distinct.ts | 87.50% |
| runtime/emit | binary.ts | 68.15% |
| runtime/emit | limit-offset.ts | 62.50% |
| runtime/emit | cast.ts | 54.55% |
| runtime/emit | unary.ts | 52.08% |
| runtime/emit | scan.ts | 53.85% |
| vtab/memory | module.ts | 66.67% |
| vtab/memory | table.ts | 35.09% |
| vtab/memory | connection.ts | 40.00% |

**Tests added (140 net new tests, 1728 → 1868):**

| Test file | Type | Tests | Targets |
|-----------|------|-------|---------|
| test/planner/predicate-normalizer.spec.ts | unit+integration | 50 | OR-to-IN collapse, De Morgan, comparison inversion, identity checks |
| test/optimizer/expression-fingerprint.spec.ts | unit (additions) | 40 | Commutative ordering, BETWEEN NOT flag, window/aggregate/CASE |
| test/optimizer/binding-collector.spec.ts | integration | 14 | Parameter/correlation collection, deduplication |
| test/optimizer/const-pass.spec.ts | integration | 35 | Constant classification, border detection, replacement |
| test/logic/104-emit-mutation-kills.sqllogic | sqllogic | ~40 assertions | cast null, bigint filter, negative limit/offset, null arithmetic, unary edge cases |
| test/logic/101-builtin-mutation-kills.sqllogic | sqllogic | ~157 assertions | Null guards, edge cases for scalar/string/aggregate/conversion functions |
| test/logic/105-vtab-memory-mutation-kills.sqllogic | sqllogic | ~164 assertions | IS NULL on NOT NULL, index planning, composite PK, savepoints, ALTER TABLE |

**Coverage improvement — `planner/stats` (2026-04-15):**

| Metric | Before | After |
|--------|--------|-------|
| Lines | 51.1% | 87.4% |
| Branches | 64.8% | 92.6% |
| Functions | 40.3% | 97.7% |

Tests added: `test/planner/stats/{basic-estimates,histogram,catalog-stats,index}.spec.ts`, `test/logic/108-cardinality-estimation.sqllogic`. Covers all join type branches, aggregate grouping, filter/limit boundaries, histogram selectivity for all operators, CatalogStatsProvider predicate extractors (equality, range, IS NULL, IN, BETWEEN, LIKE, FK→PK joins), NaiveStatsProvider heuristics, and `createStatsProvider` factory.

**Common equivalent mutant patterns** (not worth killing):
- Debug `note` string construction (cosmetic, no behavioral impact)
- Identity-check optimizations (`a === b ? b : new(...)` — returns same logical value either way)
- Resource cleanup in `finally` blocks (e.g., `outputSlot.close()`)

**Coverage improvement — `temporal-arithmetic` (2026-04-16):**

Tests added: `test/runtime/temporal-arithmetic.spec.ts` (97 unit tests), `test/logic/107-temporal-arithmetic-mutation-kills.sqllogic` (~80 assertions). Covers all `tryTemporalArithmetic` operator/type combinations (date/time/datetime/timespan ±, timespan ×/÷), `tryTemporalComparison` for all comparison operators with zero/negative/equivalent-representation timespans, month-boundary rollover, leap year Feb 29→Feb 28, negative intervals, NULL propagation, commutative orderings, and the three `binary.ts` dispatch paths (temporal, numeric-fast, generic).

**Next steps:**
- Re-run Stryker periodically to track score improvements
- Target `constraint-extractor.ts` (47.97%) — largest file with most survivors (176)
- Consider per-file ignore lists for documented equivalent mutants
