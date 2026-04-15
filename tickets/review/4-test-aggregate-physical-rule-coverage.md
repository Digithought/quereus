description: Test coverage for ruleAggregatePhysical — raised branch coverage from 70.8% to 86.66%
files:
  packages/quereus/test/plan/aggregate-physical-selection.spec.ts
  packages/quereus/test/logic/109-aggregate-physical-selection.sqllogic
  packages/quereus/src/planner/rules/aggregate/rule-aggregate-streaming.ts
---

## What was built

16 plan-shape tests in `aggregate-physical-selection.spec.ts` covering every reachable branch of `ruleAggregatePhysical`:

- **Scalar aggregate** (no GROUP BY) → StreamAggregate, no Hash, no Sort
- **Already-sorted source** (PK ordering) → StreamAggregate without Sort
  - Single PK, composite PK full match, composite PK prefix
- **Unsorted source** → HashAggregate (cost-based, hash always wins)
- **isOrderedForGrouping edge cases**:
  - Expression GROUP BY (non-column-ref) → Hash
  - Reversed composite PK order (prefix mismatch) → Hash
  - More GROUP BY keys than PK columns → Hash
  - Second key only of composite PK (not prefix) → Hash
  - First PK key + non-PK column (column mismatch at position 1) → Hash
- **Plan tree structure** assertions (parent-child relationships)
- **Correctness checks** for each aggregate strategy

Sqllogic integration tests in `109-aggregate-physical-selection.sqllogic` with `query_plan()` TVF assertions mirroring the same branches.

## Coverage

Branch coverage raised from **70.8% → 86.66%** on `rule-aggregate-streaming.ts`.

Remaining uncovered branches are **unreachable via SQL**:
- `canStreamAggregate() → false` (line 41-44): `AggregateNode.canStreamAggregate()` always returns `true`
- Sort+StreamAggregate path (lines 91-102): hash is always cheaper with current cost constants (`sortCost = n·log₂n·2.0` vs `hashCost = n·0.5 + g·1.0` — sort's O(n log n) overhead makes it strictly more expensive)
- `idx < 0` in `isOrderedForGrouping` (lines 129-130): defensive check; planner ensures column reference attribute IDs exist in source

A follow-up ticket has been filed: `tickets/plan/3-dead-sort-stream-aggregate-branch.md`.

## Testing

```bash
yarn test --grep "ruleAggregatePhysical"   # 16 passing
yarn test --grep "109"                      # 1 passing (sqllogic suite)
yarn test                                   # 1934 passing, 0 failing
```

## Usage

The tests serve as living documentation of the aggregate physical selection decision tree. When modifying `ruleAggregatePhysical`, run `yarn test --grep "ruleAggregatePhysical"` to verify all decision branches still produce the expected physical operators.
