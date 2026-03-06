description: Predicate pushdown now traverses AliasNode boundaries (enables view optimization)
files:
  - packages/quereus/src/planner/rules/predicate/rule-predicate-pushdown.ts
  - packages/quereus/test/optimizer/predicate-pushdown.spec.ts
  - packages/quereus/test/logic/08-views.sqllogic
----

## What was built

Added an `AliasNode` case to `tryPushDown()` in `rule-predicate-pushdown.ts`. When a `FilterNode` sits above an `AliasNode` (common after view expansion), the predicate is now pushed below the alias boundary, allowing it to continue descending through Project, Sort, etc. and ultimately into the Retrieve pipeline for index exploitation.

The pattern mirrors the existing `SortNode`/`DistinctNode` cases — reconstruct AliasNode with filtered source underneath. This is safe because AliasNode only renames `relationName` on attributes; attribute IDs (which predicates reference) are unchanged.

## Key use cases for testing/validation

1. **Basic view pushdown**: `SELECT * FROM view WHERE id = N` — predicate should push through Alias → Project → into Retrieve (zero residual FILTER nodes in query_plan)
2. **Qualified column references**: `SELECT v.name FROM v WHERE v.id = N` — qualified references resolve correctly after pushdown
3. **Correctness**: View with base WHERE + outer WHERE returns correct rows
4. **Plan shape**: `query_plan()` shows 0 FILTER nodes when predicate is fully pushed into index seek

## Tests

- `predicate-pushdown.spec.ts`: 2 new tests — pushdown through AliasNode, qualified column references through AliasNode
- `08-views.sqllogic`: 2 new cases — view filter pushdown correctness, qualified column reference through view alias

## Build/test status

- Build: clean
- All predicate-pushdown and views tests pass (8/8)
- Full suite: 1 pre-existing failure in `08.1-semi-anti-join.sqllogic` (unrelated — passes when run in isolation)
