description: Optimizer rule to merge adjacent Filter nodes into a single AND-combined Filter
dependencies: optimizer framework, predicate pushdown
files:
  - packages/quereus/src/planner/rules/predicate/rule-filter-merge.ts (new)
  - packages/quereus/src/planner/optimizer.ts
  - packages/quereus/test/optimizer/filter-merge.spec.ts (new)
  - packages/quereus/test/logic/08-views.sqllogic
----

## Summary

Added `ruleFilterMerge` — a structural rewrite rule that merges adjacent FilterNodes into a single Filter with an AND-combined predicate:

```
Filter(pred_outer) → Filter(pred_inner) → source
→ Filter(pred_outer AND pred_inner) → source
```

The rule iteratively absorbs all directly adjacent filters in one visit (handles triple+ stacks).

## Implementation

- **rule-filter-merge.ts**: Checks if a Filter's source is also a Filter. If so, combines predicates using `BinaryOpNode` with operator `AND`, iterating through any chain of adjacent filters.
- **optimizer.ts**: Registered in the Structural pass at priority 21 (just after predicate-pushdown at 20), so pushdown fires first and may create adjacent filters for merge to clean up.

## Key Tests

- `filter-merge.spec.ts`:
  - **View WHERE + outer WHERE** → verifies single Filter in plan and correct results
  - **Nested views** → verifies adjacent filters are merged (fewer than original count) and correct results
  - **Correctness preservation** → verifies results match expected output through merged filters
- `08-views.sqllogic`: Added filter merge correctness case with view WHERE + outer WHERE

## Notes

- Retrieve boundaries between filters prevent merge across view nesting levels. Adjacent filters within the same Retrieve boundary are merged.
- The rule is always safe: `Filter(A) → Filter(B)` ≡ `Filter(A AND B)`.
- Build passes, all 803 tests pass.
