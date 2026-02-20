---
description: Generalize access path selection to use secondary indexes for seek/range operations
dependencies: Titan optimizer core (existing), index infrastructure (existing), memory vtab module
---

## Context

The access path selection pipeline has all layers wired end-to-end:

```
ruleGrowRetrieve → ruleSelectAccessPath → selectPhysicalNode → {SeqScan, IndexScan, IndexSeek}Node
       ↓                    ↓                     ↓
  FilterInfo/idxStr    getBestAccessPlan()    scan-plan.ts → base-cursor / transaction-cursor
```

The **runtime** already supports secondary index scanning (equality + range + ordering) via
`base-cursor.ts` and `transaction-cursor.ts`, including the PK-lookup step. The **scan plan
builder** (`scan-plan.ts:resolveIndexName`) already parses non-primary index names from
`idxStr`. The **memory module** (`module.ts:getBestAccessPlan`) already evaluates both primary
and secondary indexes via `gatherAvailableIndexes()`.

However, `selectPhysicalNode` in `rule-select-access-path.ts` **hardcodes `'primary'`** for all
seek/range physical nodes. Secondary indexes are only considered for ordering
(`accessPlan.orderingIndexName`). This means secondary indexes are evaluated at planning time but
the chosen index identity is lost before it reaches the physical node.

## Gap Analysis

### G1: `BestAccessPlanResult` has no general `indexName` field
Only `orderingIndexName` exists. The planner can't know which index the module chose for
filtering.

### G2: `selectPhysicalNode` builds seek keys from PK columns only
Lines 228-268: `pkCols.map(pk => eqByCol.get(pk.index))`. For a secondary index on column `age`,
the seek key must reference the `age` constraint, not the PK constraint.

### G3: `idxStr` encoding hardcodes `_primary_`
Lines 254, 301: `idx=_primary_(0);plan=2|3`. The scan-plan builder needs the actual index name
to route to the correct B-tree at runtime.

### G4: No composite prefix + range support
For index `(a, b)`, the query `WHERE a = 1 AND b > 5` should use a prefix-equality + range scan.
Currently `evaluateIndexAccess` only does full equality OR first-column-only range.

### G5: IN constraints ignored in `findEqualityMatches`
The constraint extractor produces `op: 'IN'` constraints, but `findEqualityMatches` only checks
`op === '='`.

## Design

### Phase A: Extend `BestAccessPlanResult` (best-access-plan.ts)

Add two fields:

```ts
interface BestAccessPlanResult {
  // ... existing fields ...
  /** Name of the index chosen for this access plan (undefined = full scan / module decision) */
  indexName?: string;
  /** Column indexes that form the seek key, in order (parallel to seekKeys in IndexSeekNode) */
  seekColumnIndexes?: readonly number[];
}
```

- `indexName`: `'_primary_'` or the secondary index name (e.g., `'idx_age'`)
- `seekColumnIndexes`: which table columns the seek/range applies to, in order. Needed by
  `selectPhysicalNode` to build the correct seek key expressions from constraints.

Update `AccessPlanBuilder` with `.setIndexName()` and `.setSeekColumns()`.
Update `validateAccessPlan` to check `seekColumnIndexes` validity.

### Phase B: Memory module returns index identity (module.ts)

Update `evaluateIndexAccess` to set `indexName` and `seekColumnIndexes` in the result.
Update `findEqualityMatches` to also match `op === 'IN'` (single-value IN treated as equality).
Add prefix equality + trailing range matching for composite indexes.

### Phase C: Generalize `selectPhysicalNode` (rule-select-access-path.ts)

Replace PK-hardcoded logic with index-agnostic logic:

1. Read `accessPlan.indexName` (fall back to `'primary'` if absent for backward compat).
2. Read `accessPlan.seekColumnIndexes` to build seek keys from the correct constraints (not
   necessarily PK columns).
3. Encode the correct index name in `idxStr` (e.g., `idx=idx_age(0);plan=2`).
4. Keep existing PK fast-path as a special case for backward compatibility.

Decision flow in `selectPhysicalNode`:

```
if accessPlan.indexName && accessPlan.seekColumnIndexes:
  // Module told us exactly which index and columns
  if all seekColumnIndexes have equality constraints → IndexSeekNode (plan=2)
  elif seekColumnIndexes have range constraints → IndexSeekNode isRange (plan=3)
  else → IndexScanNode (if ordering available) or SeqScanNode
else:
  // Legacy path: existing PK-based logic (unchanged)
```

### Phase D: Tests (new spec file + additions to existing)

New file: `test/optimizer/secondary-index-access.spec.ts`

| Test | Description |
|------|-------------|
| equality seek on secondary index | `WHERE age = 30` with `CREATE INDEX idx_age ON t(age)` → IndexSeek using idx_age |
| range scan on secondary index | `WHERE age > 25` → IndexSeek (range) using idx_age |
| composite prefix + range | `CREATE INDEX idx_na ON t(name, age)`, `WHERE name = 'Alice' AND age > 20` → IndexSeek (range) on idx_na |
| ordering via secondary index | `ORDER BY age` → IndexScan using idx_age (no explicit sort) |
| cost preference: secondary vs full scan | Secondary index seek should have lower cost than SeqScan |
| end-to-end correctness | Verify actual query results match expected rows |

## Key Files

| File | Change |
|------|--------|
| `packages/quereus/src/vtab/best-access-plan.ts` | Add `indexName`, `seekColumnIndexes` to result; update builder |
| `packages/quereus/src/vtab/memory/module.ts` | Set new fields in `evaluateIndexAccess`; enhance matching |
| `packages/quereus/src/planner/rules/access/rule-select-access-path.ts` | Generalize `selectPhysicalNode` |
| `packages/quereus/test/optimizer/secondary-index-access.spec.ts` | New test file |

## TODO

### Phase A — Interface extension
- [ ] Add `indexName` and `seekColumnIndexes` to `BestAccessPlanResult`
- [ ] Add `setIndexName()` and `setSeekColumns()` to `AccessPlanBuilder`
- [ ] Update `validateAccessPlan` for new fields

### Phase B — Memory module
- [ ] Set `indexName` and `seekColumnIndexes` in `evaluateIndexAccess` results
- [ ] Handle `IN` in `findEqualityMatches`
- [ ] Add prefix-equality + trailing-range matching for composite indexes

### Phase C — Physical node selection
- [ ] Add index-aware branch in `selectPhysicalNode` using `accessPlan.indexName` + `seekColumnIndexes`
- [ ] Build seek keys from correct constraints (not PK-hardcoded)
- [ ] Encode correct index name in `idxStr`
- [ ] Keep legacy PK path for backward compatibility

### Phase D — Tests
- [ ] Secondary index equality seek test
- [ ] Secondary index range scan test
- [ ] Composite index prefix + range test
- [ ] Ordering via secondary index test
- [ ] Cost preference test
- [ ] End-to-end correctness tests
