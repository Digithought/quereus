---
description: Transform correlated EXISTS and IN subqueries in WHERE clauses to semi/anti joins
dependencies: Titan optimizer (pass framework, rule registry), join infrastructure (JoinNode, BloomJoinNode, emitter), correlation detector, binding collector
---

## Problem

Correlated subqueries in WHERE predicates re-execute the inner query for every outer row. For `EXISTS (SELECT ... WHERE inner.col = outer.col)`, this is O(N*M) — a nested-loop over the full inner relation per outer row. Transforming these into joins allows the optimizer to choose hash joins (O(N+M)) and participate in join enumeration.

## Scope

Transform correlated `EXISTS` and `IN` subqueries that appear in WHERE-clause `FilterNode` predicates into equivalent semi/anti joins. Scalar subqueries and non-correlated subqueries are out of scope (scalar subqueries require aggregation preservation; non-correlated subqueries are addressed by the IN-materialization task).

## Architecture

### Semi/Anti Join Semantics

A **semi join** returns each left row at most once if any matching right row exists. An **anti join** returns each left row only if no matching right row exists. These are the relational equivalents of EXISTS and NOT EXISTS filters.

```
-- Current plan:
Filter[EXISTS(correlated subquery)]
  └─ Scan(outer)

-- Decorrelated plan:
SemiJoin(outer.col = inner.col)
  ├─ Scan(outer)
  └─ Scan(inner)
```

### JoinType Extension

Add `'semi'` and `'anti'` to the existing `JoinType` union in `join-node.ts`:

```typescript
export type JoinType = 'inner' | 'left' | 'right' | 'full' | 'cross' | 'semi' | 'anti';
```

Semi/anti joins have distinct output shape: **only left-side attributes** are produced (the right side is checked for existence but not projected). This affects `getAttributes()`, `getType()`, and `estimatedRows` on JoinNode.

### Decorrelation Rule

A new optimizer rule `ruleSubqueryDecorrelation` runs in the **Structural pass** (top-down, rewrite phase) on `Filter` nodes. It inspects the filter predicate for correlated `ExistsNode` / `InNode` expressions and rewrites them to semi/anti joins.

#### Applicability Conditions

The rule fires when ALL of:
1. The node is a `FilterNode`
2. The predicate (after normalization) contains a top-level `ExistsNode` or `InNode` (possibly under `NOT`)
   - For AND-connected predicates: each conjunct is checked independently
3. The subquery inside EXISTS/IN is correlated (references outer attributes)
4. The correlation predicate is a simple equi-join condition (column = column across inner/outer)
5. The subquery's correlation references resolve to attributes from the filter's source

#### Transformation: EXISTS → Semi Join

```
Filter[EXISTS(Filter[corr_pred](inner_scan))](outer_scan)
→ SemiJoin[corr_pred](outer_scan, inner_scan)
```

Steps:
1. Extract the `ExistsNode` from the filter predicate
2. Identify the inner subquery's relational source and its correlation predicate
3. Separate the correlation condition (references both inner and outer) from pure inner-only conditions
4. Build a `JoinNode` with `joinType: 'semi'`, left = filter's source, right = inner source (with any inner-only filters preserved), condition = correlation predicate
5. If the original filter had additional conjuncts (beyond the EXISTS), wrap the join in a new `FilterNode` with those residual predicates

#### Transformation: NOT EXISTS → Anti Join

Same as above but produces `joinType: 'anti'`.

#### Transformation: IN (subquery) → Semi Join

```
Filter[outer.col IN (SELECT inner.col FROM ...)](outer_scan)
→ SemiJoin[outer.col = inner.col](outer_scan, inner_scan)
```

The IN condition becomes an equi-join condition. NULL semantics: IN with NULLs has three-valued logic (`NULL IN (1, NULL)` → `NULL`), but for a WHERE filter only truthy values pass, so the semi-join (which doesn't match NULLs) is equivalent.

NOT IN is more subtle due to NULL semantics and is deferred — it requires either an anti join with special NULL handling or a guard condition.

### Physical Execution

Semi/anti joins use existing physical join infrastructure:

**Nested-loop path** (default): The existing `emitLoopJoin` in `runtime/emit/join.ts` gains semi/anti support — for semi joins, it emits the left row on the *first* right match and breaks; for anti joins, it emits the left row only if no right match is found.

**Hash join path**: `BloomJoinNode` and `ruleJoinPhysicalSelection` gain awareness of semi/anti types. A hash semi join builds the right side into a hash map, then probes each left row — matching left rows are emitted (once). Hash anti join: left rows that find no match are emitted. This is the same O(N+M) as a regular hash join but without Cartesian expansion of duplicates.

### Cost Model

Semi/anti joins are cheaper than inner joins because they never produce more rows than the left input. The cost model in `cost/index.ts` adds:

```typescript
semiJoinCost(outerRows, innerRows) = nestedLoopJoinCost(outerRows, innerRows)  // same NL cost
hashSemiJoinCost(buildRows, probeRows) = hashJoinCost(buildRows, probeRows)    // same hash cost
// But estimatedRows = outerRows (semi) or outerRows * selectivity (anti)
```

The key gain is in `estimatedRows`: semi joins produce at most `outerRows` rows (no Cartesian expansion), which cascades favorably through upstream cost estimation.

### Attribute & Key Handling

Semi/anti joins produce only the left side's attributes (the right side is not projected). This simplifies output type computation and key propagation — the left side's unique keys are preserved unchanged.

```typescript
// In JoinNode.buildAttributes() / getType():
if (joinType === 'semi' || joinType === 'anti') {
    return leftAttrs;  // No right-side attributes
}
```

### Interaction with Other Rules

- **Predicate pushdown**: Runs before decorrelation (same structural pass). Pure inner-only predicates on the inner subquery are already pushed down before decorrelation sees them.
- **QuickPick join enumeration**: Currently only handles INNER/CROSS. Semi/anti joins should be excluded from enumeration (their semantics are order-dependent). Verify QuickPick's extraction phase skips them.
- **Join physical selection**: Extended to handle semi/anti. Equi-pair extraction works the same way; the physical selection rule just needs to accept the new join types.
- **Bloom join**: Extended to emit semi/anti-aware probing logic.
- **Materialization advisory**: Subqueries that have been decorrelated into joins no longer appear as ExistsNode/InNode in the tree, so materialization advisory naturally stops applying to them.

### Key Files

| File | Change |
|------|--------|
| `src/planner/nodes/join-node.ts` | Extend JoinType, update getAttributes/getType/estimatedRows for semi/anti |
| `src/planner/nodes/plan-node-type.ts` | No change needed (reuse existing `Join` type) |
| `src/planner/rules/subquery/rule-subquery-decorrelation.ts` | **New** — decorrelation rule |
| `src/planner/optimizer.ts` | Register decorrelation rule in structural pass |
| `src/planner/rules/join/rule-join-physical-selection.ts` | Accept semi/anti join types |
| `src/planner/nodes/bloom-join-node.ts` | Accept semi/anti join types |
| `src/runtime/emit/join.ts` | Semi/anti nested-loop logic |
| `src/runtime/emit/bloom-join.ts` | Semi/anti hash join logic |
| `src/planner/cost/index.ts` | Semi/anti cost functions (or reuse existing) |
| `src/planner/rules/join/rule-quickpick-enumeration.ts` | Verify semi/anti excluded from enumeration |
| `src/planner/cache/correlation-detector.ts` | Existing — used to check correlation |
| `test/logic/07.6-subqueries.sqllogic` | Existing tests must continue passing |
| `test/logic/XX-semi-anti-join.sqllogic` | **New** — targeted semi/anti join tests |

## TODO

### Phase 1: Semi/Anti Join Infrastructure
- Extend `JoinType` with `'semi' | 'anti'` in `join-node.ts`
- Update `JoinNode.buildAttributes()` and `getType()` to produce left-only output for semi/anti
- Update `JoinNode.estimatedRows` for semi/anti semantics
- Update `JoinNode.computePhysical()` — semi/anti preserves left unique keys
- Update `JoinNode.toString()` / `getLogicalAttributes()` for display

### Phase 2: Nested-Loop Emission
- Extend `emitLoopJoin` in `runtime/emit/join.ts` for semi join (emit left row on first match, break inner loop)
- Extend `emitLoopJoin` for anti join (emit left row only if no match found)
- Add basic sqllogic tests for semi/anti joins created manually via the planner

### Phase 3: Decorrelation Rule
- Implement `ruleSubqueryDecorrelation` in new file `src/planner/rules/subquery/rule-subquery-decorrelation.ts`
- Handle correlated EXISTS → semi join
- Handle NOT EXISTS → anti join
- Handle correlated IN (subquery) → semi join
- Handle AND-connected predicates (decorrelate individual conjuncts)
- Register rule in optimizer structural pass (after predicate pushdown, priority allows pushdown to run first)

### Phase 4: Hash Join Extension
- Extend `ruleJoinPhysicalSelection` to accept semi/anti join types
- Extend `BloomJoinNode` to accept semi/anti
- Extend `emitBloomJoin` for semi (first-match) and anti (no-match) probe logic

### Phase 5: Testing
- Add `test/logic/XX-semi-anti-join.sqllogic` with comprehensive patterns:
  - Correlated EXISTS → semi join
  - NOT EXISTS → anti join
  - IN (correlated subquery) → semi join
  - Multi-column correlation predicates
  - Subqueries with inner-only filters (residuals preserved)
  - NULL handling edge cases
  - Mixed predicates (EXISTS AND other_condition)
  - Verify uncorrelated subqueries are NOT decorrelated (left alone for materialization)
  - Verify scalar subqueries are NOT affected
- Verify all existing tests pass (especially 07.6-subqueries.sqllogic)
- Add query_plan() introspection tests to verify semi/anti join appears in plan
