description: Review aggregate predicate pushdown rule (first FD-machinery consumer)
files:
  - packages/quereus/src/planner/rules/predicate/rule-aggregate-predicate-pushdown.ts (new)
  - packages/quereus/src/planner/analysis/predicate-conjuncts.ts (new — shared splitConjuncts/combineConjuncts)
  - packages/quereus/src/planner/optimizer.ts
  - packages/quereus/src/planner/rules/subquery/rule-subquery-decorrelation.ts (now imports the shared conjunct helpers)
  - packages/quereus/test/optimizer/rule-aggregate-predicate-pushdown.spec.ts (new)
  - packages/quereus/test/logic/07-aggregates.sqllogic
  - docs/optimizer.md
----

## What was built

`ruleAggregatePredicatePushdown` — splits a `FilterNode` above an `AggregateNode | StreamAggregateNode | HashAggregateNode` so that conjuncts referencing only GROUP-BY-determined columns are rewritten onto the aggregate's source attribute IDs and moved below the aggregate. Conjuncts referencing aggregate outputs (sum/count/etc.) or non-column GROUP-BY expressions stay above. This subsumes both the WHERE-on-group-by-column and HAVING-on-group-by-column cases (HAVING is a `FilterNode` directly above the aggregate by the time we see it).

Algorithm:

1. Skip scalar aggregates (`groupBy.length === 0`).
2. Build `outputAttrId → { sourceAttrId, sourceColIdx }` for each bare-`ColumnReferenceNode` GROUP BY output; collect the corresponding output indices.
3. Compute `computeClosure(groupByOutputIndices, agg.physical.fds)` to get the pushable output index set. This is the first FD-machinery consumer — composite GROUP BYs whose members FD-determine each other land their FD closure here.
4. Normalize → `splitConjuncts` → partition: pushable iff every column reference in the conjunct maps to an output index in the pushable set AND has a source mapping.
5. Rebuild the pushable conjuncts by substituting output `ColumnReferenceNode`s with new ones using source `attributeId` / `columnIndex` / type, build a `FilterNode` over `agg.source`, then re-construct the aggregate over the new filtered source using `this.getAttributes()` as `preserveAttributeIds` so the residual outer Filter still references the right output columns.
6. If residual conjuncts remain, wrap the new aggregate in a `FilterNode` carrying them.

Registered in the Structural pass at priority 19 (before `rulePredicatePushdown` at 20), so any predicate placed below an aggregate by this rule is visible to the cross-node pushdown rule and can keep propagating into Retrieve.

Conjunct helpers (`splitConjuncts` / `combineConjuncts`) were extracted to `packages/quereus/src/planner/analysis/predicate-conjuncts.ts` and the subquery-decorrelation rule was migrated to use them — keeps the two rules in lockstep on the AND-tree shape.

## Use cases / testing

`packages/quereus/test/optimizer/rule-aggregate-predicate-pushdown.spec.ts` (7 cases) drives a memory-backed `orders(id, customer_id, region, total)` and a hash-aggregate-routed `u(grp, val)`:

- WHERE on a GROUP BY column: full pushdown, no Filter above the aggregate.
- HAVING on a GROUP BY column: full pushdown, no Filter above the aggregate.
- HAVING on `sum(total)`: rule must not fire; Filter stays above.
- Mixed `HAVING grp-col > C AND sum(...) > C`: split — residual stays above, pushable goes below.
- Non-bare GROUP BY (`group by customer_id + 1`): rule must not fire; Filter stays above.
- Hash-aggregate route (no index on grouping column): predicate still pushes below the aggregate.
- Scalar aggregate (no GROUP BY) + HAVING: rule must not fire (`groupBy.length === 0` guard).

Plan-shape assertions use `query_plan(?)` and check the index of `FILTER` vs `STREAMAGGREGATE`/`HASHAGGREGATE` in the parent-first traversal.

`packages/quereus/test/logic/07-aggregates.sqllogic` gained two regression rows: a `HAVING grp > 'a'` case and a mixed `HAVING grp >= 'b' AND sum(val) > 40` case — guards against result-set drift from the rewrite.

## Validation

- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn test` — 2818 passing, 2 pending (no new failures); includes the new optimizer spec and the full logic suite.

## Docs

- Added rule entry under "Predicate" in `docs/optimizer.md`.
- Added a cross-reference under "Functional Dependency Tracking" noting that this rule is the first consumer of `physical.fds` via `computeClosure`.

## Review focus

- The rewriter's substitution of `ColumnReferenceNode` (output attrId → source attrId, columnIndex, type) — confirm `srcAttr.type` is a safe drop-in (AggregateNode builds its GROUP BY output attribute as `expr.getType()` of the bare column ref, which is the same `ScalarType` as the source attribute).
- Rebuilding the aggregate via direct constructor with `preserveAttributeIds = this.getAttributes()` (rather than `withChildren`) — `StreamAggregateNode` / `HashAggregateNode.withChildren` would forward the existing `preserveAttributeIds` field which can be `undefined` for nodes built outside the optimizer; this rule needs preserved IDs unconditionally so the residual outer Filter's column refs still resolve.
- The FD-closure check is currently a no-op tighter than the bare-column GROUP BY check (since `propagateAggregateFds` only projects FDs whose members all map to bare-column GROUP BY outputs, the closure stays within that set). It buys us nothing today, but it's the correct shape for composition with future rules that widen `agg.physical.fds` (e.g. when EC merging fires on a join below the aggregate). Worth confirming that's the desired posture.
- The shared `splitConjuncts`/`combineConjuncts` extraction — confirm no other call sites should migrate at the same time.
