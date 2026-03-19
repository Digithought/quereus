description: adjustPlanForOrdering claims ordering from index not used for access — correctness and cost bug
dependencies: memory module getBestAccessPlan, rule-select-access-path physical node selection
files: packages/quereus/src/vtab/memory/module.ts, packages/quereus/src/planner/rules/access/rule-select-access-path.ts, packages/quereus/src/vtab/best-access-plan.ts, packages/quereus/src/vtab/memory/layer/scan-plan.ts
----

## Summary

`MemoryTableModule.adjustPlanForOrdering` checks whether *any* available index satisfies the required ordering, regardless of whether that index is the one chosen for data access. When a secondary index is selected for filtering but a different index (e.g., PK) satisfies the ordering, the method decorates the filtering plan with `providesOrdering` and `orderingIndexName` from the unrelated index while leaving `indexName` and `seekColumnIndexes` pointing at the filter index.

This produces two defects:

1. **Correctness**: The planner's physical node selection (`selectPhysicalNodeFromPlan`) creates an `IndexSeekNode` that iterates the filter index but claims to provide ordering from the unrelated index. The `SortNode` above is eliminated, producing mis-ordered results.

2. **Cost bias**: The 10% cost discount (`cost * 0.9`) is applied to the filtering plan regardless of whether the plan actually scans in the ordering index's order, potentially biasing plan selection away from plans that truly provide ordering or that would benefit more from a cheap post-sort.

## Reproduction scenario

Table with PK on `(id)` and secondary index on `(status)`. Query:

```sql
select * from t where status = 'active' order by id
```

- `evaluateIndexAccess` picks `idx_status` for the equality seek (cheapest filtering).
- `adjustPlanForOrdering` finds `_primary_` satisfies `ORDER BY id`, sets `orderingIndexName: '_primary_'` and `providesOrdering`, but `indexName` stays `idx_status`.
- `selectPhysicalNodeFromPlan` creates an `IndexSeekNode` on `idx_status` with `providesOrdering` claiming PK order.
- Data iterates in `status` index order, not `id` order. Sort is eliminated. Wrong results.

## Why the ordering-only scan path doesn't mitigate

The ordering-only `IndexScanNode` fallback in `selectPhysicalNodeFromPlan` (lines 609–633) only triggers when no seek/range constraints exist. When the plan has `indexName` + `seekColumnIndexes` (filtering case), we exit early with an `IndexSeekNode` carrying the incorrect ordering claim.

## Design: competing plan evaluation

Rather than decorating the already-chosen filtering plan, generate the ordering-index-based scan as a **separate competing candidate** and pick the cheaper of:

- **Plan A**: Best filtering plan + external sort cost
- **Plan B**: Ordering index scan (claiming ordering) + residual filter cost for any unhandled predicates

### Approach

Replace `adjustPlanForOrdering` with a method that:

1. For each index that satisfies the required ordering:
   - Evaluate a full-scan plan on that index (provides ordering, no sort needed).
   - Estimate residual filter cost for any filters the ordering index doesn't handle.
   - The plan's cost is: index scan cost + residual filter cost.
2. For the existing best filtering plan:
   - If the filtering index itself satisfies ordering, claim it directly (safe — same index).
   - Otherwise, add estimated sort cost to the plan's cost.
3. Return whichever plan is cheapest.

The sort cost estimate should reflect the actual row count: `rows * log2(rows) * sortCostPerComparison`. This replaces the arbitrary 10% discount with a principled cost comparison.

### Interface changes

`BestAccessPlanResult` already has separate `indexName` (filter) and `orderingIndexName` fields. The invariant to enforce is: **`providesOrdering` may only be set when `orderingIndexName` equals `indexName`, or when the plan is an ordering-only scan with no seek constraints.** This ensures `selectPhysicalNodeFromPlan` can never create a seek node that lies about its ordering.

### Key tests

- Secondary index seek + ORDER BY on PK columns → sort NOT eliminated, correct ordering
- PK seek + ORDER BY on PK columns → sort eliminated, correct ordering
- No filters + ORDER BY matching secondary index → ordering-only IndexScanNode on that secondary index
- Secondary index seek + ORDER BY matching that same secondary index → sort eliminated
- Cost comparison: ordering-only scan on PK vs secondary seek + sort, verify the cheaper plan wins
- Regression: queries without ORDER BY are unaffected
