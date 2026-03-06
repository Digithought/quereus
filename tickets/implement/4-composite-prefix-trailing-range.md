description: Composite index prefix-equality + trailing-range seeks for MemoryTable
dependencies: none (builds on existing composite equality seek + single-column range scan)
files:
  - packages/quereus/src/vtab/memory/module.ts (evaluateIndexAccess, findRangeMatch)
  - packages/quereus/src/vtab/memory/layer/scan-plan.ts (ScanPlan, ScanPlanRangeBound, buildScanPlanFromFilterInfo, extractRangeBounds)
  - packages/quereus/src/vtab/memory/layer/base-cursor.ts (scanBaseLayer, planAppliesToKey)
  - packages/quereus/src/vtab/memory/layer/transaction-cursor.ts (scanTransactionLayer, planAppliesToKey)
  - packages/quereus/src/vtab/memory/layer/safe-iterate.ts (safeIterate — startKey already supports composite keys)
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts (selectPhysicalNodeFromPlan)
  - docs/memory-table.md (remove limitation note)
----

## Problem

For a composite index `idx(a, b)`, the query `WHERE a = 1 AND b > 5` currently cannot use the index for the `b` range — it falls through to a first-column-only range scan or full scan. The BTree already stores entries in full composite key order, so entries with `a=1` are contiguous and ordered by `b` within that prefix. We just need to teach the planner and cursor to exploit this.

## Design

### New plan type: `plan=7` (prefix-range)

Represents prefix-equality columns followed by a trailing-range column on the same composite index. The idxStr encoding is:

```
idx=myIndex(0);plan=7;prefixLen=N
```

Where `N` is the number of equality-prefix columns. The args array contains `[prefixVal1, ..., prefixValN, lowerBound?, upperBound?]` — prefix values first, then 0–2 range bound values.

### Layer 1: Module access evaluation (`module.ts`)

In `evaluateIndexAccess`, after checking full equality (line 227) and before the first-column range check (line 247):

```
if (equalityMatches.matchCount > 0 && equalityMatches.matchCount < indexCols.length) {
    // Check trailing column (the one right after the equality prefix) for range constraints
    const trailingCol = indexCols[equalityMatches.matchCount];
    const trailingRange = this.findRangeMatch(trailingCol, request.filters);
    if (trailingRange.hasRange) {
        // Merge handled filters from both equality prefix and trailing range
        const combinedHandled = equalityMatches.handledFilters.map(
            (eq, i) => eq || trailingRange.handledFilters[i]
        );
        const seekCols = indexCols.slice(0, equalityMatches.matchCount + 1).map(c => c.index);
        const estimatedRows = Math.max(1, Math.floor(estimatedTableSize / 8));
        return AccessPlanBuilder
            .rangeScan(estimatedRows)
            .setHandledFilters(combinedHandled)
            .setIndexName(index.name)
            .setSeekColumns(seekCols)
            .setExplanation(`Index prefix-range scan on ${index.name}`)
            .build();
    }
}
```

Cost should be better than first-column-only range since we're narrowing by prefix.

### Layer 2: Planner physical node selection (`rule-select-access-path.ts`)

In `selectPhysicalNodeFromPlan`, the existing flow already handles this naturally:

1. `allEquality` will be `false` (trailing column has range, not equality)
2. The code falls to the range block (lines 373–417) which finds range constraints on seek columns

**BUT** the current range block only emits range constraints, not the prefix equality values. We need a new block before the existing range block that detects the prefix+range pattern:

```
// Check for prefix-equality + trailing-range pattern
const prefixEqCols: number[] = [];
let trailingRangeCol: number | undefined;
for (const colIdx of seekCols) {
    const colConstraints = constraintsByCol.get(colIdx) ?? [];
    const eqConstraint = colConstraints.find(c =>
        c.op === '=' && handledByCol.has(c.columnIndex));
    if (eqConstraint) {
        prefixEqCols.push(colIdx);
    } else {
        const hasRange = colConstraints.some(c =>
            ['>', '>=', '<', '<='].includes(c.op) && handledByCol.has(c.columnIndex));
        if (hasRange) trailingRangeCol = colIdx;
        break;
    }
}
```

If `prefixEqCols.length > 0 && trailingRangeCol !== undefined`, emit an `IndexSeekNode` with:
- seekKeys: `[prefixEq1, ..., prefixEqN, lowerBound?, upperBound?]`
- FilterInfo constraints: equality constraints for prefix cols + range constraints for trailing col
- `idxStr: idx={name}(0);plan=7;prefixLen={N}`

### Layer 3: ScanPlan building (`scan-plan.ts`)

Add `equalityPrefix?: SqlValue[]` to `ScanPlan`.

In `buildScanPlanFromFilterInfo`, handle `plan=7`:
```
const isPrefixRangePlan = planType === 7;
if (isPrefixRangePlan && indexSchema) {
    const prefixLen = parseInt(params.get('prefixLen') ?? '0', 10);
    // First prefixLen args are equality prefix values
    const prefix = args.slice(0, prefixLen) as SqlValue[];
    // Remaining args are range bounds (extracted via extractRangeBounds
    // but targeting the trailing column, not the first column)
    // Extract range bounds from remaining constraints
    ...
    return { indexName, descending, equalityPrefix: prefix, lowerBound, upperBound, ... };
}
```

For extracting trailing-column range bounds, add a parameter to `extractRangeBounds` to specify which column to target (offset by prefixLen), or create a dedicated function.

### Layer 4: Cursor execution (`base-cursor.ts`, `transaction-cursor.ts`)

When `plan.equalityPrefix` is set, the cursor:

1. **Constructs composite start key** by combining prefix + lower bound value:
   ```
   const compositeStartKey = [...plan.equalityPrefix, plan.lowerBound?.value];
   // Use tree.find(compositeStartKey) to position
   ```
   If no lower bound, use just the prefix (positions at first entry with that prefix).

2. **Iterates forward**, checking at each entry:
   - **Prefix match**: first N columns of the entry's key must equal the prefix values. If not → break (entries are sorted, so once prefix changes, no more matches).
   - **Trailing column bounds**: check the (N+1)th column against lower/upper bounds.

3. **Early termination**: when the prefix no longer matches, break immediately.

The `planAppliesToKey` function gets a new branch:
```
if (plan.equalityPrefix) {
    const keyArr = Array.isArray(key) ? key : [key];
    // Check prefix columns match
    for (let i = 0; i < plan.equalityPrefix.length; i++) {
        if (compareSqlValues(keyArr[i], plan.equalityPrefix[i]) !== 0) return false;
    }
    // Check trailing column bounds
    const trailingValue = keyArr[plan.equalityPrefix.length];
    if (plan.lowerBound) { ... check trailingValue against lowerBound ... }
    if (plan.upperBound) { ... check trailingValue against upperBound ... }
    return true;
}
```

For the start key and early termination, use the composite key with prefix values to seek into the BTree efficiently. The BTree's `find()` already accepts composite keys.

### Interaction with DESC indexes

The BTree comparator already handles per-column DESC. When the trailing column is DESC, the range bound semantics flip (GT becomes "earlier in tree order"). The existing `compareSqlValues` in the bound check needs to account for the DESC multiplier of the trailing column. Retrieve the index column spec and apply the DESC flip.

## Key tests

- `idx(a, b)` with `WHERE a = 1 AND b > 5` → returns only rows with a=1, b>5; explain shows prefix-range scan
- `idx(a, b)` with `WHERE a = 1 AND b BETWEEN 5 AND 10` → correct bounded range within prefix
- `idx(a, b, c)` with `WHERE a = 1 AND b = 2 AND c > 5` → 2-column prefix + trailing range
- `idx(a, b)` with `WHERE a = 1 AND b > 5 AND b < 20` → both bounds
- DESC index variant: `idx(a, b DESC)` with `WHERE a = 1 AND b < 5`
- Verify rows outside prefix are not returned
- Verify early termination (not scanning entire index)
- Verify cost is better than full scan or first-column-only range

## TODO

### Phase 1: Module + scan-plan infrastructure
- Add prefix+trailing-range detection in `evaluateIndexAccess` (module.ts:242-245 area)
- Add `equalityPrefix` field to `ScanPlan` interface (scan-plan.ts)
- Handle plan=7 in `buildScanPlanFromFilterInfo` (scan-plan.ts)
- Add trailing-column-aware range bound extraction (scan-plan.ts)

### Phase 2: Planner physical node
- Add prefix+range detection block in `selectPhysicalNodeFromPlan` (rule-select-access-path.ts), between the allEquality block and the existing range block
- Emit correct FilterInfo with both prefix equality and trailing range constraints

### Phase 3: Cursor execution
- Add `equalityPrefix` handling in `planAppliesToKey` (base-cursor.ts)
- Add composite start key construction for prefix-range scans (base-cursor.ts)
- Add prefix-based early termination logic (base-cursor.ts)
- Mirror all changes in transaction-cursor.ts

### Phase 4: Tests + docs
- Add tests for all key scenarios listed above
- Update docs/memory-table.md to remove the "range scans only consider first column" limitation
