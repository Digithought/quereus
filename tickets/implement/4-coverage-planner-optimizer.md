<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-04-11T01:26:55.425Z (agent: claude)
  Log file: C:\projects\quereus\tickets\.logs\4-coverage-planner-optimizer.implement.2026-04-11T01-26-55-421Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->
description: Add tests for under-covered planner analysis, optimizer rules, stats, and plan nodes
dependencies: none
files:
  packages/quereus/src/planner/analysis/predicate-normalizer.ts
  packages/quereus/src/planner/stats/catalog-stats.ts
  packages/quereus/src/planner/stats/histogram.ts
  packages/quereus/src/planner/rules/cache/rule-mutating-subquery-cache.ts
  packages/quereus/src/planner/rules/cache/rule-in-subquery-cache.ts
  packages/quereus/src/planner/rules/distinct/rule-distinct-elimination.ts
  packages/quereus/src/planner/rules/aggregate/rule-aggregate-streaming.ts
  packages/quereus/src/planner/nodes/aggregate-function.ts
  packages/quereus/src/planner/nodes/table-function-call.ts
  packages/quereus/src/planner/nodes/hash-aggregate.ts
  packages/quereus/src/planner/nodes/limit-offset.ts
  packages/quereus/src/planner/nodes/cte-node.ts
  packages/quereus/src/planner/nodes/delete-node.ts
  packages/quereus/src/planner/cache/reference-graph.ts
  packages/quereus/src/runtime/emission-context.ts
  packages/quereus/src/runtime/context-helpers.ts
  packages/quereus/test/plan/
  packages/quereus/test/optimizer/
----
The planner and optimizer layers have 568 uncovered branches across nodes (203), rules (114),
analysis (108), and stats (43). Bugs here cause wrong query plans — queries may return correct
results via a catastrophically slow path, or worse, silently wrong results when optimizer
transformations are incorrect.

**Worst offenders:**

| File | Branch % | Uncov | Risk |
|------|----------|-------|------|
| rule-mutating-subquery-cache.ts | 36% | 7 | Side-effect detection misses → re-execution of mutations |
| aggregate-function.ts (node) | 55% | 9 | Aggregate plan construction bugs |
| table-function-call.ts (node) | 56% | 7 | TVF plan node edge cases |
| limit-offset.ts (node) | 60% | 8 | Limit/offset plan properties wrong → bad optimization |
| catalog-stats.ts | 62% | 27 | Histogram boundary bugs, wrong selectivity → bad join order |
| rule-in-subquery-cache.ts | 63% | 4 | IN-subquery caching decision errors |
| rule-distinct-elimination.ts | 66% | 2 | Distinct incorrectly eliminated → duplicate rows |
| histogram.ts | 67% | 14 | Cumulative count errors → wrong cardinality estimates |
| reference-graph.ts | 68% | 8 | CTE reference counting wrong → bad materialization decisions |
| predicate-normalizer.ts | 70% | 20 | De Morgan's law bugs, OR-to-IN collapse, NULL handling |
| hash-aggregate.ts (node) | 69% | 10 | Hash aggregate plan properties |
| rule-aggregate-streaming.ts | 70% | 7 | Streaming agg selected when input not actually sorted |
| cte-node.ts | 70% | 7 | CTE materialization vs inline decision |
| emission-context.ts | 64% | 11 | Context setup for instruction emission |
| context-helpers.ts | 68% | 15 | Runtime context resolution edge cases |

**Test strategy:** Mix of plan-shape tests (assert optimizer decisions), sqllogic correctness tests,
and optimizer unit tests.

### Predicate normalizer (20 uncovered branches — correctness critical)

- De Morgan's law: `NOT (a AND b)` → `(NOT a) OR (NOT b)`, deeply nested
- OR flattening: `(a OR b) OR c` → `a OR b OR c`
- NOT pushdown through comparisons: `NOT (x > 5)` → `x <= 5`
- NULL-aware normalization: `NOT (x IS NULL)` → `x IS NOT NULL`
- Edge: tautologies (`x OR NOT x`), contradictions (`x AND NOT x`)

### Statistics and histograms (41 uncovered branches)

- Empty table stats (zero rows)
- Single-row table stats
- All-NULL column stats
- Uniform distribution vs skewed distribution
- Histogram boundary queries: value exactly at bucket boundary
- Out-of-range selectivity estimation (value below min, above max)

### Optimizer rules (20 uncovered branches)

- **Mutating subquery cache**: INSERT/UPDATE/DELETE in subquery on join RHS — must be cached
- **IN-subquery cache**: Large IN list vs small, correlated IN-subquery
- **Distinct elimination**: Distinct on primary key (should eliminate), distinct on non-unique (should keep)
- **Streaming aggregation**: Pre-sorted input (use streaming), unsorted (use hash), partial sort match

### Plan-shape assertions

- Predicate pushed below join (plan test)
- Bloom join chosen for large equi-join (plan test)
- Streaming agg when ORDER BY matches GROUP BY (plan test)
- CTE materialized when referenced >1 time (plan test)
- Subquery decorrelated into semi-join (plan test)

TODO:
- Create `test/logic/100-predicate-normalization-edge-cases.sqllogic` — normalization correctness
- Create `test/optimizer/predicate-normalizer.spec.ts` — unit tests for normalizer
- Extend `test/plan/` with plan-shape tests for optimizer decisions listed above
- Create `test/optimizer/statistics-edge-cases.spec.ts` — histogram and catalog stats tests
- Create `test/optimizer/cache-rules.spec.ts` — mutating subquery and IN-subquery cache rules
- Add optimizer equivalence tests: run queries with/without specific rules, assert identical results
- Re-run coverage and verify branch improvements
