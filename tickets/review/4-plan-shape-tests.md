description: Review plan-shape tests asserting optimizer picks expected physical plans
dependencies: none
files:
  packages/quereus/test/plan/predicate-pushdown.spec.ts
  packages/quereus/test/plan/join-selection.spec.ts
  packages/quereus/test/plan/aggregate-strategy.spec.ts
  packages/quereus/test/plan/subquery-decorrelation.spec.ts
  packages/quereus/test/plan/cte-materialization.spec.ts
  packages/quereus/test/plan/constant-folding.spec.ts
  packages/quereus/test/plan/index-selection.spec.ts
----
Seven per-category plan-shape test files added under `test/plan/`, totaling 48 tests (all passing).
These guard against optimizer regressions where queries return correct results via a worse plan.

**What was built:**

1. **predicate-pushdown.spec.ts** (5 tests) — Asserts FILTER + JOIN co-exist for single-table
   predicates on joins; PK predicate pushed through view into INDEXSEEK; predicate through
   projection/alias reaches the base scan.

2. **join-selection.spec.ts** (6 tests) — HashJoin selected for equi-join on non-PK column;
   MergeJoin or HashJoin for PK-to-PK equi-join; NestedLoopJoin for cross join (no equi
   condition); correctness verified for each.

3. **aggregate-strategy.spec.ts** (6 tests) — StreamAggregate when input is pre-sorted (PK
   GROUP BY, sorted subquery); HashAggregate for unsorted GROUP BY; StreamAggregate for scalar
   aggregate (no GROUP BY); correctness verified.

4. **subquery-decorrelation.spec.ts** (6 tests) — Correlated EXISTS decorrelated into semi-join;
   IN subquery decorrelated into join; NOT EXISTS into anti-join; correctness for all three.

5. **cte-materialization.spec.ts** (6 tests) — Single-reference CTE inlined (no CACHE); multi-
   reference CTE has two CTEREFERENCE nodes + JOIN; recursive CTE produces RECURSIVECTE node.

6. **constant-folding.spec.ts** (10 tests) — Literal arithmetic folded (no BinaryOp); complex
   expressions folded; `1 = 1` predicate folded to literal (no BinaryOp); contradiction returns
   zero rows; VALUES folded to TableLiteral; deterministic functions folded; non-deterministic
   preserved; column-dependent expressions preserved.

7. **index-selection.spec.ts** (8 tests) — IndexSeek for equality on secondary index and PK;
   index access for range predicates; SeqScan fallback for non-indexed columns; correctness
   for all access paths.

**Testing:**
- `yarn test:plans` runs all 48 plan-shape tests (plus 1 existing golden-plans test)
- Full suite: 1915 passing, 0 failures
- TypeScript type check clean

**Notable optimizer behaviors observed:**
- Single-table predicates on joins stay above the JOIN node (FILTER above HASHJOIN) rather
  than being pushed into the join's child scan. Results are correct but plan is suboptimal.
- `WHERE 1 = 1` folds the predicate expression to a literal `true` but the FILTER node itself
  is not eliminated from the plan.
