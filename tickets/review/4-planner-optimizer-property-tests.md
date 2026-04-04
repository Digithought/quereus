description: Property-based tests targeting planner and optimizer correctness invariants
dependencies: fast-check (already in devDependencies)
files:
  - packages/quereus/test/property-planner.spec.ts (new — 20 tests across 6 property groups)
  - packages/quereus/src/planner/optimizer-tuning.ts (added disabledRules field)
  - packages/quereus/src/planner/framework/pass.ts (skip disabled rules in applyPassRules)
  - packages/quereus/src/planner/framework/registry.ts (skip disabled rules in applyRules)
----

## What was built

### Infrastructure: selective rule disabling

Added `disabledRules?: ReadonlySet<string>` to `OptimizerTuning` interface. Two guard checks skip disabled rules:
- `PassManager.applyPassRules()` in `pass.ts` (line ~380)
- `applyRules()` in `registry.ts` (line ~198)

Tests toggle rules via `db.optimizer.updateTuning({ ...baseTuning, disabledRules: new Set([ruleId]) })`.

### Test file: `test/property-planner.spec.ts` (20 tests)

**Property 1 — Semantic equivalence under optimizer rules** (8 tests):
One test per rewrite rule (`predicate-pushdown`, `filter-merge`, `distinct-elimination`, `projection-pruning`, `scalar-cse`, `join-key-inference`, `join-greedy-commute`, `subquery-decorrelation`). Each generates random schema+data, runs query with rule enabled vs disabled, asserts identical result sets.

**Property 2 — Optimizer determinism** (1 test):
Same query on same data, two fresh prepares → `query_plan()` output must be identical.

**Property 3 — Join commutativity** (1 test):
`t1 JOIN t2` vs `t2 JOIN t1` → same result set (using aliased columns to avoid name collisions).

**Property 4 — Monotonicity of WHERE** (1 test):
`count(*)` >= `count(*) WHERE col IS NOT NULL` always holds.

**Property 5 — NULL algebra** (5 tests):
- `NULL = NULL` is not true
- `NULL IN (1, 2, NULL)` yields NULL
- `COALESCE(NULL, v) = v` for any non-null v
- `IS NULL` / `IS NOT NULL` complementary
- `count(col)` with NULLs < `count(*)`

**Property 6 — Aggregate invariants** (4 tests):
- `count(*) >= count(col)`
- `min(col) <= max(col)` when both non-NULL
- Single-row: `sum(col)` equals the value
- `avg(col)` between `min(col)` and `max(col)`

## Testing notes

- All 20 new tests pass
- Full test suite: 1161 passing, 2 pending (unchanged baseline)
- `numRuns` kept low (30–50) for CI speed
- Each property test creates a fresh `Database` instance to avoid cross-test pollution
- Prepared statements are not reused across rows with potentially different physical types (null vs non-null)

## Key review points

- Verify that `disabledRules` guard placement covers all rule application paths
- Verify the rule equivalence tests are exercising meaningful query patterns per rule
- Verify no performance regression from the `disabledRules?.has()` check on the hot path (it's a Set lookup behind an optional chain — should be negligible)
