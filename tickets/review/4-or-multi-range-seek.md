description: OR disjunctions with range predicates on same index → multiple range scans
files:
  - packages/quereus/src/planner/analysis/constraint-extractor.ts
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts
  - packages/quereus/src/vtab/memory/layer/scan-plan.ts
  - packages/quereus/src/vtab/memory/layer/base-cursor.ts
  - packages/quereus/src/vtab/memory/layer/transaction-cursor.ts
  - packages/quereus/src/vtab/memory/module.ts
  - packages/quereus/src/vtab/best-access-plan.ts
  - packages/quereus/test/optimizer/or-multi-range-seek.spec.ts
----

## What Was Built

OR disjunctions with range predicates on the same index column (e.g., `WHERE price > 1000 OR price < 10`) now produce multiple range scans on the same index, concatenated at the cursor layer. Previously these fell through as residual filters with a full table scan.

### Data Flow

```
SQL: WHERE price > 1000 OR price < 10
  → constraint-extractor: tryExtractOrBranches → OR_RANGE constraint with ranges[]
  → module.evaluateIndexAccess: recognize OR_RANGE → multi-range access plan
  → rule-select-access-path: build IndexSeekNode with plan=6;rangeCount=N;rangeOps=...
  → scan-plan.buildScanPlanFromFilterInfo: plan=6 → populate ranges[]
  → base-cursor / transaction-cursor: for each range → yield* single-range scan
```

### Key Changes

1. **ConstraintOp** (`best-access-plan.ts`): Added `'OR_RANGE'` to the union type.

2. **RangeSpec + PredicateConstraint** (`constraint-extractor.ts`): New `RangeSpec` interface and `ranges?: RangeSpec[]` field. New `tryCollapseToOrRange()` function handles Case 2 in `tryExtractOrBranches` — detects all-range-same-column OR branches, including mixed equality+range (equality treated as `>= v AND <= v`).

3. **Module** (`module.ts`): New `findOrRangeMatch()` method recognizes OR_RANGE constraints in `evaluateIndexAccess`.

4. **Access Path Rule** (`rule-select-access-path.ts`): New OR_RANGE block builds IndexSeekNode with `plan=6;rangeCount=N;rangeOps=gt,le:ge,...` encoding and flattened seekKeys.

5. **ScanPlan** (`scan-plan.ts`): New `ScanPlanRange` interface, `ranges?: ScanPlanRange[]` on `ScanPlan`, and `planType === 6` handling in `buildScanPlanFromFilterInfo`.

6. **Cursors** (`base-cursor.ts`, `transaction-cursor.ts`): Multi-range decomposition loop (after equalityKeys block) decomposes into sequential single-range scans.

## Testing

10 spec tests in `test/optimizer/or-multi-range-seek.spec.ts`:

- Disjoint ranges: `price > 1000 OR price < 10`
- Bounded ranges: `(score >= 90 AND score <= 100) OR (score >= 0 AND score <= 10)`
- Mixed equality + range: `price = 50 OR price > 1000`
- Three branches: `price > 2000 OR price < 1 OR price = 100`
- Plan verification: confirms IndexSeek chosen over SeqScan
- Primary key OR-range: `id > 6 OR id < 3`
- Empty result: no matches in any range
- Single row per range
- Regression: single-range scan still works
- Regression: IN-list multi-seek still works

All 439 existing tests continue to pass (1 pre-existing failure in keys-propagation.spec.ts unrelated to this change).

## Usage

No API changes. Any SQL query with OR disjunctions of range predicates on the same indexed column will automatically benefit from multi-range index seek instead of falling back to a full scan with residual filter.
