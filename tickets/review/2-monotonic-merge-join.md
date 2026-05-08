---
description: Code-review the monotonic-aware merge-join recognition rule and its shared equi-pair-extractor refactor
prereq:
files: packages/quereus/src/planner/rules/join/rule-monotonic-merge-join.ts, packages/quereus/src/planner/rules/join/equi-pair-extractor.ts, packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/test/optimizer/monotonic-merge-join.spec.ts, packages/quereus/test/logic/83-merge-join.sqllogic, docs/optimizer.md
effort: low
---

## Summary

Adds `ruleMonotonicMergeJoin`, a new join-physical recognition rule that fires
when both join sides advertise `MonotonicOn` on the equi-pair attributes — even
when the existing ordering-based rule (`rule-join-physical-selection`) cannot
recognise the merge opportunity because `physical.ordering` is left-side-only.
The new rule is strictly additive: it defers whenever the ordering-based path
already covers all equi-pairs (so multi-key composite-PK joins continue to
flow through the existing rule with full unique-key propagation).

The implementation reuses the existing `MergeJoinNode` plan node and its
`emitMergeJoin` runtime emitter — the Phase-1 audit (recorded in the original
implement ticket) confirmed no new node class or emitter was needed.

## What landed

### New shared helper: `equi-pair-extractor.ts`
`packages/quereus/src/planner/rules/join/equi-pair-extractor.ts`
- `extractEquiPairs(condition, leftAttrIds, rightAttrIds)`: classifies AND-tree
  conjuncts into equi-pairs vs residual; now also returns `equiPairNodes`
  (the original `=` BinaryOpNode for each pair, or `undefined` for USING)
  so rules can demote pairs back into the residual.
- `extractEquiPairsFromUsing(usingColumns, leftAttrs, rightAttrs)`: USING-
  derived pairs.
- `combineResidual(base, extras)`: AND-combine an existing residual and a list
  of extra scalar conjuncts.
- `isOrderedOnEquiPairs(source, equiPairs, side)`: positional ordering check.
- `reorderEquiPairsForMerge(equiPairs, left, right)`: align pairs to left's
  ordering prefix, verifying the right side still matches.
- `isMergeReadyOnAllPairs(left, right, equiPairs)`: combination predicate
  used by the new rule to defer to the ordering-based path when appropriate.

`rule-join-physical-selection.ts` was refactored to use these shared helpers
(removed its inlined copies of `extractEquiPairs`,
`isOrderedOnEquiPairs`, `reorderEquiPairsForMerge`, and the USING-equi-pair
loop). Behavior is unchanged.

### New rule: `rule-monotonic-merge-join.ts`
`packages/quereus/src/planner/rules/join/rule-monotonic-merge-join.ts`
- Match `JoinNode` with `inner | left | semi | anti` join type.
- Extract equi-pairs from `node.condition` or `node.usingColumns`.
- **Defer** if `isMergeReadyOnAllPairs(...)` — the ordering-based rule
  handles the multi-key case better (preserves uniqueKey propagation).
- Find equi-pairs where both sides advertise `MonotonicOn` on the attrId
  in the same `asc` direction. (DESC streaming would need a reversed
  `compareKeys` in the emitter; out of scope.)
- v1: a single driving equi-pair; the rest are demoted to the residual
  using their original `=` BinaryOpNodes (USING-with-multiple-monotonic-pairs
  bails out, letting the ordering-based rule handle it).
- Cost-gate against hash and nested-loop; bail if either is cheaper.
- Construct `MergeJoinNode` with the driving pair and combined residual.

### Registration
`packages/quereus/src/planner/optimizer.ts`: registered in
`PassId.PostOptimization` at priority 4 (one ahead of
`ruleJoinPhysicalSelection` at priority 5). Once converted to `MergeJoinNode`,
the existing rule no-ops on it.

## Out of scope (parked)
- Composite monotonic-on prefixes (multi-key streaming merge keyed on `(X, Y)`
  when both sides are jointly monotonic on the prefix).
- Right and full outer joins — emitter doesn't support them.
- DESC-DESC streaming (would need a reversed `compareKeys` in the merge-join
  emit).
- USING with multiple monotonic-driving pairs (rule bails; existing rule
  handles).

## Testing & validation

- `packages/quereus/test/optimizer/monotonic-merge-join.spec.ts` (new, 12 tests):
  - PK-to-PK direct join → MERGEJOIN, not HASHJOIN.
  - LEFT JOIN on monotonic equi-pair.
  - Filter / Project pass-through preserves recognition.
  - **Headline:** three-way join `t1 JOIN t2 ON t1.id=t2.id JOIN t3 ON t2.id=t3.id`
    where the parent join is on the child MergeJoin's right-side attribute
    (the canonical case the ordering-based rule misses). Asserts both
    intermediate joins are MERGEJOIN.
  - Negative: non-equi condition, equi-join on non-monotonic column.
  - Correctness: inner/left rows, multi-conjunct ON with residual, equality
    with the rule disabled via `disabledRules: 'monotonic-merge-join'`.
  - Physical: MergeJoin advertises `monotonicOn` in physical JSON.
- `packages/quereus/test/logic/83-merge-join.sqllogic` extended:
  - Three-way-join plan-shape and correctness assertions.
  - Multi-conjunct-ON residual correctness.
  - LEFT JOIN, SEMI/ANTI via EXISTS/NOT EXISTS.
- `yarn build`: clean.
- `yarn lint`: clean.
- `yarn test`: 2597 passing, 2 pending, 0 failing.
- `yarn test:store` and `yarn test:full` deferred to CI per AGENTS.md.

## Review checklist

- [ ] `ruleMonotonicMergeJoin` deferral path: confirm `isMergeReadyOnAllPairs`
      is the right gate. Does it correctly preserve uniqueKey propagation in
      composite-PK cases? (See `keys-propagation.spec.ts` / "Composite PK join
      preserves left keys when right PK covered" — that test was the
      regression flagged during implementation.)
- [ ] Direction handling: rule requires `direction === 'asc'` on both sides.
      Verify the merge-join emit really does assume ASC. (`compareKeys` in
      `runtime/emit/merge-join.ts:20-35` returns `< 0` when `lv < rv` and the
      algorithm advances the right side past values < left — assumes ASC.)
- [ ] Cost gate: `min(hashC, nlC) < mergeC` rejects the rule. Hand-check on
      the three-way case to confirm we don't gate ourselves out.
- [ ] USING handling: rule bails when `equiPairNodes[i]` is undefined for a
      non-driving pair. Correct? (Alternative: synthesize a binary-eq
      ColumnReferenceNode for those — but the existing rule already handles
      USING fine.)
- [ ] Refactor of `rule-join-physical-selection.ts` to shared helpers:
      verify behavior is unchanged. The full test suite is the primary
      check; spot-check a multi-equi-pair PK case for plan equality.
- [ ] Docs: `docs/optimizer.md` updated under the Join rules section
      mentioning `ruleMonotonicMergeJoin`.

## Files

### New
- `packages/quereus/src/planner/rules/join/equi-pair-extractor.ts`
- `packages/quereus/src/planner/rules/join/rule-monotonic-merge-join.ts`
- `packages/quereus/test/optimizer/monotonic-merge-join.spec.ts`

### Changed
- `packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts` (refactor to shared helpers)
- `packages/quereus/src/planner/optimizer.ts` (rule registration)
- `packages/quereus/test/logic/83-merge-join.sqllogic` (extra correctness cases)
- `docs/optimizer.md` (one-line description added)
