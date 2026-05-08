---
description: Add a monotonic-aware merge-join recognition rule that fires whenever both inputs advertise MonotonicOn on the equi-join attributes — broader than the existing ordering-based rule
prereq:
files: packages/quereus/src/planner/rules/join/rule-monotonic-merge-join.ts (new), packages/quereus/src/planner/optimizer.ts, packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts, packages/quereus/src/planner/nodes/merge-join-node.ts, packages/quereus/src/planner/nodes/join-utils.ts, packages/quereus/src/runtime/emit/merge-join.ts, packages/quereus/src/planner/framework/characteristics.ts, packages/quereus/test/optimizer/monotonic-merge-join.spec.ts (new), packages/quereus/test/logic/83-merge-join.sqllogic
effort: medium
---

## Phase 1 audit conclusion: reuse existing MergeJoinNode

The plan ticket scoped a new `MonotonicMergeNode` plan node and `monotonic-merge` runtime emitter. **Audit verdict: not needed.** The existing surface is general enough:

- `packages/quereus/src/planner/nodes/merge-join-node.ts` (`MergeJoinNode`) already:
  - Holds attribute-ID-keyed `equiPairs: readonly EquiJoinPair[]`.
  - Supports inner / left / semi / anti join types.
  - Carries a `residualCondition?: ScalarPlanNode` for the non-equi remainder of the ON clause.
  - Calls `propagateJoinMonotonicOn` from `join-utils.ts` in `computePhysical`, so its output already advertises `monotonicOn` on the joined attribute IDs (this matches the plan's "output: MonotonicOn the join key").
- `packages/quereus/src/runtime/emit/merge-join.ts` already implements the classic merge algorithm: pre-resolves equi-pair column indices, materializes the right side (for duplicate runs), advances the smaller side via `compareKeys`, walks runs of equal keys, evaluates residuals, and emits NULL-padded output via `joinOutputRow` for LEFT semantics.

So this ticket does not add a plan node, an emitter, or a `PlanNodeType.MonotonicMerge` constant. It adds **only** a new recognition rule that builds the existing `MergeJoinNode`.

## Where the new rule wins (the broader recognition)

The existing rule (`packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts`) decides merge-vs-hash by reading `physical.ordering` via `PlanNodeCharacteristics.getOrdering(source)`, then matching the ordering prefix positionally against the equi-pair attribute IDs (`isOrderedOnEquiPairs`). This rejects valid merge-join inputs in important cases:

- **Joins on a monotonic attribute that isn't the leading ordering column.** A `MergeJoinNode` output declares `physical.ordering = leftPhys.ordering` (left-side ordering only) but `physical.monotonicOn = [l.X, r.X]` (both equi-pair sides). A *parent* join on `r.X` therefore sees `ordering[0].column = 0` (left's lead column) rather than the column index of `r.X`, and the existing rule fails to recognize the merge opportunity. The monotonic-aware rule looks up `r.X`'s attrId in `physical.monotonicOn`, which succeeds. This is the canonical case.
- **Strict-monotonic awareness.** `Distinct` strengthens `monotonicOn` to `strict: true` while leaving `ordering` unchanged. A future cost refinement may use the strict flag to prune duplicate-run handling — surface it now even if cost doesn't yet differentiate.
- **Composability with future propagation.** As `monotonicOn` propagation expands (e.g., `4-expression-properties-injective-monotone`, the deferred UNION-ALL-with-disjoint-X-ranges case), this rule picks them up for free; the ordering-based rule may not.

For the in-tree node set as of this ticket, `Filter`, `Project`, `Alias`, `LimitOffset`, and access plans propagate both `ordering` and `monotonicOn`, so for those the two rules largely overlap. The new rule is strictly broader, never narrower.

## The rule

`packages/quereus/src/planner/rules/join/rule-monotonic-merge-join.ts`:

```
ruleMonotonicMergeJoin(node: PlanNode, ctx: OptContext) -> PlanNode | null
  if not (node instanceof JoinNode): return null
  if joinType not in {inner, left, semi, anti}: return null      // matches existing emitter scope

  build leftAttrIds, rightAttrIds sets
  extracted = extractEquiPairs(node.condition, ...) || equi-pairs from USING
  if extracted is null or extracted.equiPairs is empty: return null

  leftMon  = leftPhysical.monotonicOn  // PlanNodeCharacteristics.getMonotonicOn(node.left)
  rightMon = rightPhysical.monotonicOn
  if leftMon empty or rightMon empty: return null

  // Pick the equi-pair(s) where both sides are monotonic with matching direction.
  matched = []
  for each pair in extracted.equiPairs:
    l = leftMon.find(m => m.attrId === pair.leftAttrId)
    r = rightMon.find(m => m.attrId === pair.rightAttrId)
    if l && r && l.direction === r.direction: matched.push(pair)
  if matched is empty: return null

  // v1: single equi-pair drives the merge order; remaining equi-pairs become
  // additional conjuncts in residual (still equi but not monotonic-driving).
  // Multi-key composite-monotonic merge is parked.
  driving = [matched[0]]
  extraEqui = extracted.equiPairs.filter(p => p !== matched[0])
  residual = combineAnd(extracted.residual, ...extraEqui as binary-eq nodes)

  // Cost compare: merge (free order) vs hash. Skip if hash strictly cheaper.
  leftRows  = node.left.estimatedRows ?? 100
  rightRows = node.right.estimatedRows ?? 100
  mergeC = mergeJoinCost(leftRows, rightRows, /*needsLeftSort*/ false, /*needsRightSort*/ false)
  hashC  = hashJoinCost(min(leftRows, rightRows), max(leftRows, rightRows))
  nlC    = nestedLoopJoinCost(leftRows, rightRows)
  if min(hashC, nlC) < mergeC: return null

  return new MergeJoinNode(
    scope, node.left, node.right, joinType,
    driving, residual, node.getAttributes().slice() as Attribute[]
  )
```

### Key contract points

- **No SortNode insertion.** This rule only fires when both sides are *already* monotonic on the equi-key — the whole point. If the inputs aren't monotonic, the existing `rule-join-physical-selection` is responsible for choosing whether to sort and merge or to hash.
- **One driving equi-pair, others residualized.** A query like `JOIN ... ON l.X = r.X AND l.Y = r.Y` where only `X` is monotonic on both sides becomes a streaming merge keyed on `X`, with `l.Y = r.Y` evaluated as a residual. v1 limit: composite monotonic-on prefixes (both sides MonotonicOn on `(X, Y)` in matching order) are out of scope; document inline as TODO.
- **Direction agreement is required.** A pair where left is `monotonicOn(X, asc)` but right is `monotonicOn(X, desc)` is rejected. Reversing one side requires a Sort, which defeats the rule's premise.
- **Cost gate.** Even when the precondition holds, hash join can win on tiny inputs (constant-factor build cost is small). The cost gate above keeps this rule from regressing those plans.
- **Idempotency / coexistence with `rule-join-physical-selection`.** Both rules guard with `if (!(node instanceof JoinNode)) return null;`. Once the monotonic rule converts a node to `MergeJoinNode`, the physical-selection rule no-ops on it. Run the monotonic rule **first** within the same pass via lower priority (see registration below).

## Registration

`packages/quereus/src/planner/optimizer.ts`:

```ts
this.passManager.addRuleToPass(PassId.PostOptimization, {
  id: 'monotonic-merge-join',
  nodeType: PlanNodeType.Join,
  phase: 'impl',
  fn: ruleMonotonicMergeJoin,
  priority: 4,   // before join-physical-selection (priority 5)
});
```

The plan ticket's `files:` line cited `planner/framework/registry.ts` — that's the registry implementation, not where rules are registered. Register in `optimizer.ts` next to the existing `join-physical-selection` and `monotonic-limit-pushdown` registrations.

## Helpers to reuse

Several pieces in `rule-join-physical-selection.ts` are immediately useful:

- `extractEquiPairs(condition, leftAttrIds, rightAttrIds)` — already classifies AND-tree conjuncts into equi-pairs vs residuals. Either import it (export it from the existing file) or factor both rules onto a shared `equi-pair-extractor.ts` in `planner/rules/join/`.
- `PlanNodeCharacteristics.getMonotonicOn(node)` already exists from ticket `1-monotonic-on-characteristic` (in `packages/quereus/src/planner/framework/characteristics.ts`). Use it.
- `mergeJoinCost`, `hashJoinCost`, `nestedLoopJoinCost` from `planner/cost/`. Match the existing rule's invocation patterns.

Prefer factoring `extractEquiPairs` into a shared helper module rather than duplicating it; the two rules are otherwise about to drift.

## Outer-join semantics (Phase 3 of plan ticket)

The existing emitter handles `inner`, `left`, `semi`, `anti`. `right` and `full` are out of scope (both for the existing emitter via `joinOutputRow` and for `propagateJoinMonotonicOn` which drops on `full`). v1 of this rule matches that scope — it does not regress anything, since right/full joins go to nested-loop or hash today regardless. A right-join could be served by swapping sides into a left-join, but that's a separate enhancement and out of scope.

## Tests

### Plan-shape tests — `packages/quereus/test/optimizer/monotonic-merge-join.spec.ts` (new)

Pattern after `bestaccessplan-monotonic-advertisement.spec.ts` and `monotonic-limit-pushdown.spec.ts` (both in same folder).

- **Direct PK-to-PK monotonic equi-join → fires.** Two memory tables with INTEGER PRIMARY KEY, joined on PK; `query_plan()` shape should include `MERGEJOIN` and not `HASHJOIN`.
- **Filter above access plan still fires.** `SELECT … FROM (SELECT * FROM t1 WHERE …) j1 JOIN (SELECT * FROM t2 WHERE …) j2 ON j1.id = j2.id`. Validates that the `MonotonicOn` propagation through `Filter` is recognized.
- **Project preserving the key still fires.** `SELECT a.id, a.x, b.id, b.y FROM (SELECT id, x FROM t1) a JOIN (SELECT id, y FROM t2) b ON a.id = b.id`.
- **Parent merge on right side's monotonic attribute fires.** Three-way join `t1 JOIN t2 ON t1.id = t2.id JOIN t3 ON t2.id = t3.id`. The mid-level `MergeJoinNode` outputs `monotonicOn` on `[t1.id, t2.id]` but `ordering` only reflects the left side. The parent's join on `t2.id = t3.id` is the case where the ordering-based rule fails and the monotonic rule wins. Assert that the parent is a `MERGEJOIN` (or both intermediate joins are merge joins) — this is the headline test for "broader than existing".
- **Direction mismatch does not fire.** Construct two sides where one is `monotonicOn(asc)` and the other `monotonicOn(desc)`. Assert no merge join.
- **Non-monotonic input does not fire.** Equi-join on a non-PK, non-indexed column. Assert no merge join (or that one is only chosen if the existing ordering-based path / sort-and-merge still wins on cost — be tolerant of either, since this rule is additive).
- **Non-equi-join condition does not fire.** `ON t1.id < t2.id` — assert no merge join from this rule.
- **Cost gate: tiny inputs do not regress.** With `t1` and `t2` each holding a handful of rows, hash join may win on constant factors — the rule must not regress this. Assert that whatever the planner picks (merge or hash) executes correctly; this is a regression guard, not a positive recognition assertion.

### SQL logic tests — extend `packages/quereus/test/logic/83-merge-join.sqllogic`

Add cases covering correctness of the new path:

- Inner merge on PK-PK with duplicate runs on the join key (use a non-unique index — composite PK with a free suffix on one side, so `monotonicOn` is non-strict). Verify `n × m` cross-product within each run.
- LEFT JOIN where some left rows have no matching right run — verify NULL padding.
- SEMI / ANTI join on monotonic equi-pair — verify match/no-match semantics.
- Multi-conjunct ON clause: `ON l.id = r.id AND l.code = r.code` where only `id` is monotonic on both sides; the second conjunct must be evaluated as residual without breaking correctness.
- A query that constructs the parent-merge-on-right-attribute case (three-way join), verifying not just plan shape but result correctness.

### Negative tests

The plan-shape spec already covers these; no SQL logic addition needed.

## Validation

- `cd packages/quereus && yarn lint`
- `cd packages/quereus && yarn test 2>&1 | tee /tmp/test.log` — full quereus test suite, no regressions. Streaming pattern is required (silent redirect can trip the 10-minute idle kill).
- `yarn build` from repo root (Yarn 4 monorepo).
- Skip `yarn test:store`, `yarn test:full`. Defer to a human / CI per AGENTS.md.

## Out of scope (parked, document inline as TODOs)

- Composite monotonic-on prefixes — multi-key streaming merge keyed on `(X, Y)` when both sides are jointly monotonic on the prefix.
- Right and full outer joins — emitter doesn't support them.
- Recognizing `monotonicOn(asc)` against `monotonicOn(desc)` by reversing one side via Sort. Defeats the rule's premise.

## TODO

### Phase 1: factor or import the equi-pair extractor
- Read `rule-join-physical-selection.ts` and decide whether to export `extractEquiPairs` from there, or factor it into `planner/rules/join/_equi-pair-extractor.ts`. Lean toward factoring — the two rules are otherwise about to drift on identical logic.

### Phase 2: implement `rule-monotonic-merge-join.ts`
- Per the rule pseudocode above. Use `PlanNodeCharacteristics.getMonotonicOn` from `framework/characteristics.ts`.
- Reuse `MergeJoinNode` from `planner/nodes/merge-join-node.ts` — do **not** add a new node class or emitter.
- Cost-gate via `mergeJoinCost` / `hashJoinCost` / `nestedLoopJoinCost` from `planner/cost/`.

### Phase 3: register the rule in `optimizer.ts`
- `PassId.PostOptimization`, priority `4` (before `join-physical-selection` at priority `5`).

### Phase 4: tests
- Add `packages/quereus/test/optimizer/monotonic-merge-join.spec.ts` per the plan-shape outline above, including the headline three-way-join test.
- Extend `packages/quereus/test/logic/83-merge-join.sqllogic` with the correctness cases listed.

### Phase 5: validation
- `yarn lint` clean, `yarn test` green, `yarn build` green.

### Phase 6: docs
- One-line mention in `packages/quereus/docs/optimizer.md` join section, alongside the existing merge-join paragraph: "Monotonic-merge join recognition (`rule-monotonic-merge-join`) fires whenever both join sides advertise `MonotonicOn` on the equi-pair attributes — strictly broader than ordering-based recognition, picks up cases where ordering is left-side-only but `MonotonicOn` covers both sides."
