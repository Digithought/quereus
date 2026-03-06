description: Projection pruning optimizer rule — eliminates unused columns from inner ProjectNode in Project-on-Project patterns
dependencies: optimizer framework, view expansion
files:
  - packages/quereus/src/planner/rules/retrieve/rule-projection-pruning.ts (new)
  - packages/quereus/src/planner/optimizer.ts (rule registration)
  - packages/quereus/test/optimizer/projection-pruning.spec.ts (new)
  - packages/quereus/test/logic/08-views.sqllogic (added pruning correctness cases)
----

## What was built

A structural rewrite rule (`ruleProjectionPruning`) that detects Project-on-Project patterns (common after view expansion) and prunes unused inner projections.

### Algorithm

When an outer `ProjectNode`'s source is another `ProjectNode`:
1. Collect attribute IDs referenced by the outer project's scalar expressions (walking all `ColumnReferenceNode` leaves).
2. Filter the inner project's projections to only those whose output attributes are in the referenced set.
3. Rebuild both nodes preserving attribute IDs.

The rule skips pruning when all inner projections are referenced or when pruning would result in zero projections.

### Registration

Registered in the Structural pass at priority 19 (between distinct-elimination at 18 and predicate-pushdown at 20), targeting `PlanNodeType.Project`.

## Testing

### Unit tests (`projection-pruning.spec.ts` — 5 tests)
- Prunes unused view projections when outer selects a subset (verifies via `query_plan()` projectionCount)
- Returns correct results after pruning with a WHERE filter
- Preserves all columns when all are referenced
- Handles join with view where only some view columns are used
- Handles `count(*)` from view (correctness, not row-dependent on projections)

### SQL logic tests (`08-views.sqllogic`)
- `SELECT name FROM wide_view` — correctness after pruning a 4-column view to 1
- `SELECT name, value FROM wide_view WHERE id = 2` — correctness with filter + partial projection

### Build & full test suite
- Build passes cleanly
- Lint passes cleanly on new file
- 267 tests pass; 1 pre-existing failure in `08.1-semi-anti-join.sqllogic` (unrelated)

## Usage

Automatic — the rule fires during the optimizer's structural pass whenever view expansion or nested subqueries produce stacked ProjectNode trees with unreferenced columns.
