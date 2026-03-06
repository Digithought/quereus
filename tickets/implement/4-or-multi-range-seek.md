description: OR disjunctions with range predicates on same index → multiple range scans
dependencies: none — all infrastructure exists (constraint-extractor, scan-plan, cursor layer, access-path rule)
files:
  - packages/quereus/src/planner/analysis/constraint-extractor.ts
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts
  - packages/quereus/src/vtab/memory/layer/scan-plan.ts
  - packages/quereus/src/vtab/memory/layer/base-cursor.ts
  - packages/quereus/src/vtab/memory/layer/transaction-cursor.ts
  - packages/quereus/src/vtab/memory/module.ts
  - packages/quereus/src/vtab/best-access-plan.ts
  - packages/quereus/src/planner/nodes/table-access-nodes.ts
  - packages/quereus/src/runtime/emit/scan.ts
----

## Summary

OR disjunctions with range predicates on the same index columns (e.g., `WHERE price > 1000 OR price < 10`) should produce multiple range scans on the same index, concatenated at the cursor layer. Currently these fall through as residual filters because `tryExtractOrBranches` in `constraint-extractor.ts` only collapses OR-of-equality to IN (Case 1) and returns null for range disjunctions (Case 2 is a stub).

## Architecture

The existing IN-list multi-seek pattern provides a clean model. IN multi-seek works as:
1. Constraint extractor collapses `x=1 OR x=2` → IN constraint
2. Access path rule builds IndexSeekNode with multiple seekKeys, `plan=5;inCount=N`
3. ScanPlan has `equalityKeys: BTreeKey[]`
4. Cursor layer loops: `for key of equalityKeys → yield* scanSingle(key)`

Multi-range seek follows the same decomposition, but with ranges instead of equality keys:

1. Constraint extractor detects OR branches that are all range constraints on the same column+index → produces a new `OR_RANGE` constraint type containing the list of range specs
2. Access path rule builds IndexSeekNode with range specs serialized into `plan=6;rangeCount=N`
3. ScanPlan gains `ranges: ScanPlanRange[]` — each with its own lowerBound/upperBound
4. Cursor layer loops: `for range of ranges → yield* scanSingleRange(range)`

### Data Flow

```
SQL: WHERE price > 1000 OR price < 10
  ↓
constraint-extractor: tryExtractOrBranches → OR_RANGE constraint
  { op: 'OR_RANGE', columnIndex: 0, ranges: [{op:'>',val:1000}, {op:'<',val:10}] }
  ↓
module.evaluateIndexAccess: recognize OR_RANGE → multi-range plan
  { indexName, seekColumnIndexes, handledFilters, cost = sum(range costs) }
  ↓
rule-select-access-path: detect OR_RANGE constraints → build IndexSeekNode
  seekKeys = [1000, 10], isRange=true, filterInfo.idxStr = "plan=6;rangeCount=2;..."
  ↓
scan-plan.buildScanPlanFromFilterInfo: plan=6 → populate ranges[]
  ↓
base-cursor / transaction-cursor: for each range → yield* single-range scan
```

### Key Design Decisions

1. **No duplicate elimination needed** for disjoint ranges — ranges on the same column from OR branches are naturally disjoint (if they overlapped, the predicate would simplify to a single range). We still need to verify disjointness or accept possible duplicates (filter above can deduplicate if needed).

2. **Reuse IndexSeekNode** — no new plan node type. The `isRange=true` flag + new plan type `6` distinguishes multi-range from single-range (`plan=3`).

3. **New constraint op `OR_RANGE`** — a compound constraint that carries the list of per-branch range specs. This keeps the constraint extraction → access planning pipeline clean.

4. **Ordering**: Multi-range scans can preserve index ordering if the ranges are scanned in order (sorted by lower bound for ASC index). Worth doing since it's cheap.

## Detailed Changes

### Phase 1: Constraint Extraction

**File: `constraint-extractor.ts`**

In `tryExtractOrBranches`, expand the Case 2 stub (line 603) to detect when all OR branches have range constraints on the same column of the same table:

- For each branch, check if it has only range ops (`>`, `>=`, `<`, `<=`) on a single column, or a BETWEEN (which is already decomposed into `>=` + `<=` pair)
- Collect the per-branch range specs: `{ lower?: {op,value,valueExpr}, upper?: {op,value,valueExpr} }`
- Produce a single `PredicateConstraint` with `op: 'OR_RANGE'` and a new field `ranges` carrying the range list
- Mixed equality+range branches on the same column should also work: `x = 5 OR x > 10` → treat equality as `{lower: {op:'>=',val:5}, upper: {op:'<=',val:5}}`

**Type changes in `constraint-extractor.ts`:**
```ts
export interface RangeSpec {
  lower?: { op: '>=' | '>'; value: SqlValue; valueExpr?: ScalarPlanNode };
  upper?: { op: '<=' | '<'; value: SqlValue; valueExpr?: ScalarPlanNode };
}

// Extend PredicateConstraint:
export interface PredicateConstraint extends VtabPredicateConstraint {
  // ... existing fields ...
  /** Range specifications for OR_RANGE constraints */
  ranges?: RangeSpec[];
}
```

**Type changes in `best-access-plan.ts`:**

Add `'OR_RANGE'` to the `ConstraintOp` type union.

### Phase 2: Access Planning (Module)

**File: `module.ts` — `evaluateIndexAccess`**

After the existing range match check, add recognition for `OR_RANGE` constraints:

- If any filter has `op === 'OR_RANGE'` and its columnIndex matches the first index column, produce a multi-range plan
- Cost = sum of individual range costs (each range ≈ `estimatedTableSize / (4 * rangeCount)`)
- Set `handledFilters[i] = true` for the OR_RANGE filter
- Return with `indexName`, `seekColumnIndexes`, plan type distinguishes it

### Phase 3: Access Path Rule

**File: `rule-select-access-path.ts` — `selectPhysicalNodeFromPlan`**

After the existing IN multi-seek block (~line 303) and range block (~line 374), add a new block for OR_RANGE:

- Find OR_RANGE constraint on a seek column
- Extract the ranges from the constraint
- Build seekKeys: flatten all bound values from all ranges into a single seekKeys array
- Build filterInfo with `plan=6;rangeCount=N` plus encoded range ops
- Create IndexSeekNode with `isRange=true`

The seekKeys order: for each range, emit lower-value then upper-value (either may be absent). Encode which slots are lower vs upper bounds in the idxStr.

### Phase 4: ScanPlan

**File: `scan-plan.ts`**

Add `ScanPlanRange` type and extend `ScanPlan`:

```ts
export interface ScanPlanRange {
  lowerBound?: ScanPlanRangeBound;
  upperBound?: ScanPlanRangeBound;
}

export interface ScanPlan {
  // ... existing fields ...
  /** Multiple ranges for OR-range multi-seek */
  ranges?: ScanPlanRange[];
}
```

In `buildScanPlanFromFilterInfo`, handle `planType === 6`:
- Parse `rangeCount` and range op encoding from idxStr params
- Build `ranges[]` from args, 2 args per range (lower, upper — either may be null sentinel)

### Phase 5: Cursor Layer

**Files: `base-cursor.ts`, `transaction-cursor.ts`**

At the top of each scan function, after the `equalityKeys` multi-seek block, add:

```ts
if (plan.ranges && plan.ranges.length > 0) {
  for (const range of plan.ranges) {
    const singlePlan: ScanPlan = {
      ...plan,
      ranges: undefined,
      lowerBound: range.lowerBound,
      upperBound: range.upperBound,
    };
    yield* scanBaseLayer(layer, singlePlan);  // or scanTransactionLayer
  }
  return;
}
```

This decomposes multi-range into sequential single-range scans, reusing all existing range scan logic (start key selection, early termination, DESC index handling).

### Phase 6: Runtime Emission

**File: `scan.ts`**

No changes needed — the existing `emitSeqScan` already passes all seekKeys as dynamic args, and the scan-plan builder reconstructs range info from args + idxStr. The only requirement is that seekKeys in the IndexSeekNode correspond correctly to the expected args layout.

## Encoding Convention for plan=6

idxStr format: `idx=<name>(<offset>);plan=6;rangeCount=<N>;rangeOps=<encoded>`

Where `rangeOps` is a compact encoding of which bounds each range has:
- `L` = lower only (>, >=)
- `U` = upper only (<, <=)
- `B` = both bounds
- Specific ops encoded per bound: `gt`/`ge`/`lt`/`le`

Example for `price > 1000 OR price < 10`:
- Range 0: lower only (>1000) → 1 arg
- Range 1: upper only (<10) → 1 arg
- `plan=6;rangeCount=2;rangeOps=gt,lt`
- args = [1000, 10]

Example for `score BETWEEN 0 AND 10 OR score BETWEEN 90 AND 100`:
- Range 0: both (>=0, <=10) → 2 args
- Range 1: both (>=90, <=100) → 2 args
- `plan=6;rangeCount=2;rangeOps=ge:le,ge:le`
- args = [0, 10, 90, 100]

## Tests

Key test scenarios (sqllogic or spec):

- `WHERE price > 1000 OR price < 10` on indexed price column → expect IndexSeek with plan=6, correct results
- `WHERE score BETWEEN 90 AND 100 OR score BETWEEN 0 AND 10` → two bounded ranges
- `WHERE date > '2024-01' OR date < '2023-06'` → two disjoint date ranges
- `WHERE x = 5 OR x > 10` → equality + range, mixed
- `WHERE x > 100 OR x < 10 OR x = 50` → three branches (two range + one equality)
- Verify plan output shows IndexSeek not SeqScan
- Verify correct results (no missing/duplicate rows)
- Edge case: overlapping ranges `WHERE x > 5 OR x > 10` → should still work (possible duplicates are fine since OR semantics already deduplicate logically)
- Secondary index: same patterns on a secondary index column
- DESC index: ensure correct scan direction

----

## TODO

### Phase 1: Constraint Extraction
- Add `RangeSpec` interface and `ranges` field to `PredicateConstraint` in `constraint-extractor.ts`
- Add `'OR_RANGE'` to `ConstraintOp` in `best-access-plan.ts`
- Extend `tryExtractOrBranches` Case 2: detect all-range-same-column OR branches, produce OR_RANGE constraint with ranges list
- Handle mixed equality+range branches (treat `=v` as `>=v AND <=v`)

### Phase 2: Access Planning
- In `module.ts` `evaluateIndexAccess`, add OR_RANGE recognition: check if any filter has `op === 'OR_RANGE'` matching first index column
- Build multi-range access plan with appropriate cost model and handled filters

### Phase 3: Access Path Rule
- In `rule-select-access-path.ts` `selectPhysicalNodeFromPlan`, add OR_RANGE block after existing range block
- Build seekKeys from ranges (flatten bound values), construct filterInfo with `plan=6;rangeCount=N;rangeOps=...`
- Create IndexSeekNode with `isRange=true`

### Phase 4: ScanPlan
- Add `ScanPlanRange` interface and `ranges?: ScanPlanRange[]` to `ScanPlan` in `scan-plan.ts`
- Handle `planType === 6` in `buildScanPlanFromFilterInfo`: parse rangeCount/rangeOps, build ranges from args

### Phase 5: Cursor Layer
- Add multi-range decomposition to `scanBaseLayer` in `base-cursor.ts` (after equalityKeys block)
- Add multi-range decomposition to `scanTransactionLayer` in `transaction-cursor.ts` (after equalityKeys block)

### Phase 6: Tests
- Add sqllogic tests for OR-range scenarios (disjoint ranges, bounded ranges, mixed eq+range)
- Add plan-level tests verifying IndexSeek is chosen over SeqScan
- Test secondary indexes and DESC indexes with multi-range
