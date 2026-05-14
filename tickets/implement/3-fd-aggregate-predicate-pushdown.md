---
description: Push WHERE/HAVING predicates from above an aggregate down to below it when the predicate references only GROUP-BY columns (or columns FD-determined by them)
prereq: fd-property-foundation, fd-from-equivalence-classes
files:
  - packages/quereus/src/planner/rules/predicate/rule-aggregate-predicate-pushdown.ts (new)
  - packages/quereus/src/planner/optimizer.ts (register rule in Structural pass)
  - packages/quereus/src/planner/nodes/aggregate-node.ts (reference)
  - packages/quereus/src/planner/nodes/stream-aggregate.ts (reference)
  - packages/quereus/src/planner/nodes/hash-aggregate.ts (reference)
  - packages/quereus/src/planner/rules/predicate/rule-predicate-pushdown.ts (reference, for conjunct-walking style)
  - packages/quereus/src/planner/rules/subquery/rule-subquery-decorrelation.ts (reference — has `splitConjuncts` / `combineConjuncts` to copy)
  - packages/quereus/src/planner/util/fd-utils.ts (reference — `computeClosure`)
  - packages/quereus/src/planner/analysis/predicate-normalizer.ts (reference — used by sibling rule)
  - packages/quereus/test/optimizer/rule-aggregate-predicate-pushdown.spec.ts (new)
  - packages/quereus/test/logic/06-aggregates.sqllogic
  - docs/optimizer.md
---

## Goal

Add `ruleAggregatePredicatePushdown` to the Structural pass. It targets
`FilterNode(predicate, AggregateNode|StreamAggregateNode|HashAggregateNode)` and
pushes conjuncts that reference only GROUP-BY-determined columns below the
aggregate, leaving the rest above.

This subsumes both the simple "filter on a GROUP BY column" case and the
HAVING-clause case (HAVING is represented as `FilterNode` directly above an
aggregate). With FD propagation already landed, predicates on columns
FD-determined by a GROUP BY column are also pushable.

## Algorithm

For `FilterNode(predicate, agg)` where `agg` is one of `AggregateNode`,
`StreamAggregateNode`, `HashAggregateNode`:

1. Normalize `predicate` via the shared `normalizePredicate` helper, then split
   into conjuncts (`splitConjuncts` — copy the helper from
   `rule-subquery-decorrelation.ts` or extract to a shared util).
2. Build the aggregate output→source attribute-id map from the aggregate's
   GROUP BY: for each `groupBy[i]` that is a bare `ColumnReferenceNode`,
   `agg.getAttributes()[i].id` (output attrId) maps to `groupBy[i].attributeId`
   (source attrId). Aggregate output columns (indices ≥ groupCount) have no
   source mapping.
3. Compute the set of source attribute IDs that are output of bare GROUP-BY
   columns; this is the "pushable source set."
4. For each conjunct:
   - Collect its referenced output attribute IDs (walk
     `ColumnReferenceNode`s; reuse pattern from
     `rule-predicate-pushdown.ts:collectReferencedAttributeIds`).
   - Each referenced ID must (a) be in the output→source map (group-by column
     mapped to a real source attribute) OR (b) be FD-determined under
     `agg.physical.fds` by the set of mapped GROUP-BY output IDs (use
     `computeClosure` on the aggregate's *output* FDs, starting from the
     bare-column GROUP BY output IDs). Any conjunct referencing an
     aggregate-output column (sum/count/etc.) or a non-column GROUP-BY
     expression must stay above.
5. Partition the conjuncts into `pushable` and `remaining`.
6. If `pushable` is empty → `return null` (rule didn't fire).
7. Rewrite the pushable conjunction's `ColumnReferenceNode`s from output
   attribute IDs to source attribute IDs (substitute via the map built in
   step 2). Subtree-rebuild via `withChildren`, similar to existing scalar
   rewriters.
8. Build below-aggregate: `FilterNode(agg.source.scope, agg.source, pushableConjunction)`.
9. Rebuild the aggregate over the new filtered source via `withChildren` (so
   attribute IDs of the aggregate's output stay stable).
10. Build the result: if `remaining` is empty → return the new aggregate
    directly; else `FilterNode(filter.scope, newAggregate, remainingConjunction)`.

## Why FD closure helps

Once `fd-from-equivalence-classes` and the foundation are in, an aggregate's
`physical.fds` already include relationships *between* GROUP BY columns (e.g.
`customer_id → region` when both are grouped and the source supplies that FD).
Reading the closure on the output side means a predicate on `region` is
recognized as pushable even though it's not the column we built the source
mapping from. The substitution in step 7 still works because `region` *is* a
GROUP BY output (otherwise it wouldn't be in the aggregate output schema at
all).

The cases where the FD machinery yields strictly more pushdown than naive
"is-the-attrId-a-bare-group-by-column" pushdown are narrow but real (composite
GROUP BYs whose members FD-determine each other). Composition with
`rule-predicate-inference-equivalence` (separate ticket) widens it further by
producing more conjuncts above the aggregate that then become pushable.

## Edge cases

- `groupBy.length === 0` (scalar aggregate): no pushable conjuncts — the
  predicate is filtering the single output row. Return `null`.
- `groupBy[i]` is a non-`ColumnReferenceNode` expression: that output column
  has no source mapping; predicates referencing it stay above.
- HAVING on aggregate output (`HAVING sum(x) > 1000`): the conjunct references
  an attribute outside the output→source map and outside its FD closure → stays
  above.
- The aggregate node's `withChildren` re-uses original attribute IDs when
  `preserveAttributeIds` is set — verify newly-rebuilt aggregate keeps stable
  IDs so the residual outer Filter still references the right columns. (See
  `aggregate-node.ts:218-226` and equivalent in stream/hash.)
- Pushing across `StreamAggregateNode` may insert a Filter between the sort
  source and the stream aggregate — the new Filter must not break ordering
  required by the stream aggregate. Filter is order-preserving, so this is
  safe; just don't accidentally drop an existing `SortNode` between them.

## Tests (`packages/quereus/test/optimizer/rule-aggregate-predicate-pushdown.spec.ts`)

Unit / plan-shape tests via `query_plan(?)` (consistent with sibling specs in
`test/optimizer/`):

- `select customer_id, sum(total) from orders where customer_id > 100 group by customer_id`
  → Filter node moves below the aggregate; outer Filter is gone.
- `select customer_id, sum(total) from orders group by customer_id having customer_id > 100`
  → HAVING pushed; same shape as previous.
- `select customer_id, sum(total) from orders group by customer_id having sum(total) > 1000`
  → NOT pushed; Filter stays above the aggregate, no Filter below.
- Mixed conjunct: `... having customer_id > 100 and sum(total) > 1000`
  → split: `customer_id > 100` below, `sum(total) > 1000` above. Verify both
  Filters are present.
- Non-column GROUP BY: `group by customer_id + 1 having (customer_id + 1) > 100`
  → NOT pushed (group-by expression is not a bare column reference; no source
  mapping).
- FD-aware: composite GROUP BY where source supplies a FD between members;
  predicate on the FD-dependent column above pushes (requires constructing a
  source whose `fds` include the relationship — easiest via a primary-key /
  unique-key table joined into the source so the aggregate inherits the FD).
- StreamAggregate path: same as test 1 but with a sort hint or `ANALYZE` that
  picks stream aggregate. Confirm Filter slot below the sort/stream-agg.
- HashAggregate path: same with a hint that picks hash aggregate.

Logic regression in `test/logic/06-aggregates.sqllogic`: add a small block
with a HAVING-on-group-by-column query plus its expected rows (rule must not
change result rows). Existing aggregate tests should also continue to pass —
they exercise the optimizer end-to-end and would catch any plan/result drift.

## Documentation

- `docs/optimizer.md` — add a new entry under "Predicate" with rule id
  `aggregate-predicate-pushdown`, sketch the algorithm, and cross-reference
  the FD framework section.
- No `docs/architecture.md` change needed.

## Out of scope

- Aggregate-itself pushdown across joins — tracked by
  `tickets/backlog/3-aggregate-pushdown.md`.
- Partial / split aggregation when only some inputs are filterable.
- Pushing across non-aggregate operators (already covered by
  `rule-predicate-pushdown`).

## TODO

Implementation

- Create `packages/quereus/src/planner/rules/predicate/rule-aggregate-predicate-pushdown.ts`.
- Implement `splitConjuncts` / `combineConjuncts` locally (or extract the
  existing copy in `rule-subquery-decorrelation.ts` to
  `planner/analysis/predicate-conjuncts.ts` and import from both — preferred
  if the diff stays small).
- Implement the attribute-id rewriter for `ColumnReferenceNode` (subtree
  rebuild via `withChildren`).
- Wire FD-closure check using `agg.physical.fds` and `computeClosure`.
- Register the rule in `packages/quereus/src/planner/optimizer.ts` in the
  Structural pass with `nodeType: PlanNodeType.Filter`, priority between
  `predicate-pushdown` (20) and `filter-merge` (21) — pick `priority: 19` so
  it fires *before* the cross-node predicate pushdown (so any predicate the
  aggregate-aware rule pushes below the aggregate can then propagate further
  via the existing pushdown). Confirm ordering against the test suite.

Tests

- Add `packages/quereus/test/optimizer/rule-aggregate-predicate-pushdown.spec.ts`
  with the cases listed under **Tests** above.
- Extend `packages/quereus/test/logic/06-aggregates.sqllogic` with the HAVING
  regression.
- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn test` (root) — passes, including the new optimizer spec and full
  logic suite.

Docs

- Add the rule catalog entry in `docs/optimizer.md` under "Predicate".
- Cross-reference from the FD-tracking section.
