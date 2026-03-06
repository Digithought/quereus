description: Composite index IN multi-seek for MemoryTable
dependencies: none (builds on existing single-column IN multi-seek + composite equality seek)
files:
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts (selectPhysicalNodeFromPlan)
  - packages/quereus/src/vtab/memory/layer/scan-plan.ts (buildScanPlanFromFilterInfo)
  - packages/quereus/src/vtab/memory/module.ts (evaluateIndexAccess — already works, verify only)
  - packages/quereus/src/vtab/memory/layer/base-cursor.ts (multi-seek loop — already works for composite keys)
  - packages/quereus/src/vtab/memory/layer/transaction-cursor.ts (same — already works)
  - docs/memory-table.md (remove limitation note)
----

## Problem

For a composite index `idx(a, b)`, the query `WHERE a IN (1, 2) AND b = 5` should generate two index seeks: `[1, 5]` and `[2, 5]`. Currently, single-column IN multi-seek works (plan=5), and composite equality seek works (plan=2), but **composite IN multi-seek** does not: the planner only handles `hasMultiValueIn && seekCols.length === 1` and falls through to a standard equality seek that picks only the first IN value.

## Current state

The **module** layer (`evaluateIndexAccess`) already handles this correctly:
- `findEqualityMatches` treats IN as equality for prefix matching
- It computes `inCardinality` as the product of all IN list sizes
- It returns a multi-seek plan when `inCardinality > 1`

The **cursor** layer already handles composite multi-seek:
- `scanBaseLayer`/`scanTransactionLayer` loop over `plan.equalityKeys` and do individual `tree.get(key)` lookups
- `tree.get([1, 5])` uses the composite comparator — works correctly

The gap is in two places:

1. **Planner** (`rule-select-access-path.ts` line 303): `if (hasMultiValueIn && seekCols.length === 1)` excludes composite indexes
2. **ScanPlan builder** (`scan-plan.ts` line 257-262): plan=5 reads flat args as individual single-value keys, not composite keys

## Design

### Planner: cross-product seek key generation

In `selectPhysicalNodeFromPlan`, modify the `hasMultiValueIn` block to handle `seekCols.length > 1`:

```typescript
if (hasMultiValueIn) {
    if (seekCols.length === 1) {
        // ... existing single-column IN multi-seek code ...
    } else {
        // Composite IN multi-seek: generate cross-product of all column values
        const columnValues: { colIdx: number; values: unknown[]; exprs?: ScalarPlanNode[] }[] = [];
        for (const colIdx of seekCols) {
            const c = eqBySeekCol.get(colIdx)!;
            if (c.op === 'IN' && Array.isArray(c.value) && (c.value as unknown[]).length > 1) {
                columnValues.push({
                    colIdx,
                    values: c.value as unknown as unknown[],
                    exprs: Array.isArray(c.valueExpr) ? c.valueExpr as ScalarPlanNode[] : undefined,
                });
            } else {
                // Single equality value for this column
                const val = c.op === 'IN' && Array.isArray(c.value) ? (c.value as unknown[])[0] : c.value;
                columnValues.push({ colIdx, values: [val] });
            }
        }

        // Compute cross-product
        const crossProduct = cartesianProduct(columnValues.map(cv => cv.values));
        const seekWidth = seekCols.length;

        // Build seekKeys — one ScalarPlanNode per value in flattened cross-product
        const seekKeys: ScalarPlanNode[] = crossProduct.flatMap(combo =>
            combo.map(v => new LiteralNode(tableRef.scope, { type: 'literal', value: v }))
        );

        // Build constraints: one EQ constraint per value in the flattened args
        const constraints = seekKeys.map((_sk, i) => ({
            constraint: { iColumn: seekCols[i % seekWidth], op: IndexConstraintOp.EQ, usable: true },
            argvIndex: i + 1,
        }));

        const fi: FilterInfo = {
            ...filterInfo,
            constraints,
            idxStr: `idx=${idxStrName}(0);plan=5;inCount=${crossProduct.length};seekWidth=${seekWidth}`,
        };

        return new IndexSeekNode(..., fi, physicalIndexName, seekKeys, false, providesOrdering, accessPlan.cost);
    }
}
```

Add a small `cartesianProduct` helper (local to the file):
```typescript
function cartesianProduct<T>(arrays: T[][]): T[][] {
    return arrays.reduce<T[][]>(
        (acc, arr) => acc.flatMap(combo => arr.map(v => [...combo, v])),
        [[]]
    );
}
```

### ScanPlan builder: composite key reconstruction

In `buildScanPlanFromFilterInfo`, for plan=5, check for `seekWidth`:

```typescript
} else if (isMultiSeekPlan && indexSchema) {
    const inCount = parseInt(params.get('inCount') ?? '0', 10);
    const seekWidth = parseInt(params.get('seekWidth') ?? '1', 10);
    if (inCount > 0 && args.length >= inCount * seekWidth) {
        if (seekWidth === 1) {
            // Existing: single-value keys
            equalityKeys = args.slice(0, inCount) as BTreeKey[];
        } else {
            // Composite: group args into composite keys
            equalityKeys = [];
            for (let i = 0; i < inCount; i++) {
                const start = i * seekWidth;
                const key = args.slice(start, start + seekWidth) as SqlValue[];
                equalityKeys.push(key.length === 1 ? key[0] : key);
            }
        }
    }
}
```

### No cursor changes needed

The existing multi-seek loop in `scanBaseLayer`/`scanTransactionLayer` already handles composite keys:
```typescript
if (plan.equalityKeys && plan.equalityKeys.length > 0) {
    for (const key of plan.equalityKeys) {
        const singlePlan = { ...plan, equalityKey: key, equalityKeys: undefined };
        yield* scanBaseLayer(layer, singlePlan);
    }
}
```
Each `key` in `equalityKeys` can be a composite array like `[1, 5]`, and `tree.get([1, 5])` uses the composite comparator correctly.

### Dynamic IN expressions (valueExpr)

When IN values come from parameters or OR-collapse (mixed-binding), the planner may have `valueExpr` arrays alongside literal values. The cross-product logic needs to handle expression nodes for dynamic values the same way the existing single-column IN code does: use `valueExpr` nodes when available, fall back to LiteralNode for constants.

For composite cross-products with mixed dynamic/literal columns, each combo in the cross-product maps to seekKeys that are either expression nodes or literals. This is a natural extension.

## Key tests

- `idx(a, b)` with `WHERE a IN (1, 2) AND b = 5` → 2 seeks: [1,5], [2,5]
- `idx(a, b)` with `WHERE a = 1 AND b IN (3, 4, 5)` → 3 seeks: [1,3], [1,4], [1,5]
- `idx(a, b)` with `WHERE a IN (1, 2) AND b IN (3, 4)` → 4 seeks: [1,3], [1,4], [2,3], [2,4]
- Verify correct result rows for each case
- Verify explain shows `multi-seek(N)` with correct cardinality
- Verify cost estimate reflects number of seeks
- Single-column IN still works (regression)

## TODO

### Phase 1: Planner cross-product generation
- Add `cartesianProduct` helper in rule-select-access-path.ts
- Extend the `hasMultiValueIn` block to handle `seekCols.length > 1`
- Generate composite seekKeys as flattened cross-product
- Encode `seekWidth` in idxStr for plan=5

### Phase 2: ScanPlan reconstruction
- Modify plan=5 handling in `buildScanPlanFromFilterInfo` to check `seekWidth`
- Reconstruct composite `equalityKeys` from grouped args

### Phase 3: Tests + docs
- Add tests for composite IN scenarios listed above
- Verify single-column IN regression tests still pass
- Update docs/memory-table.md to remove the "composite index IN not yet implemented" limitation
