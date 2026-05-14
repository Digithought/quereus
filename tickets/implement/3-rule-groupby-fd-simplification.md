---
description: Optimizer rule that drops GROUP BY columns functionally determined by other remaining GROUP BY columns (PK/UNIQUE/FK FDs, predicate-derived ECs). Picker MIN() aggregates re-emit dropped columns so output schema is preserved.
prereq: fd-property-foundation, fd-from-injective-projections, fd-from-equivalence-classes
files:
  - packages/quereus/src/planner/rules/aggregate/rule-groupby-fd-simplification.ts (new)
  - packages/quereus/src/planner/optimizer.ts
  - packages/quereus/src/planner/nodes/aggregate-node.ts
  - packages/quereus/src/planner/util/fd-utils.ts
  - packages/quereus/test/optimizer/rule-groupby-fd-simplification.spec.ts (new)
  - packages/quereus/test/logic/07-aggregates.sqllogic
  - docs/optimizer.md
---

## Goal

For `AggregateNode` with `groupBy = [g0..gN-1]`, drop every `gi` that's functionally
determined by the rest of the GROUP BY list under the source's FDs + ECs. Schema-preserving:
each dropped column is re-emitted as a `MIN(<original-expr>)` aggregate so output attribute
IDs survive. Cuts hash slots / sort key width on the common FK-join-then-aggregate shape.

## Architecture

### Where in the pipeline

Register in the **Structural pass** at **priority 23** — after `aggregate-predicate-pushdown` (19),
`predicate-pushdown` (20), `filter-merge` (21), `scalar-cse` (22); before
`subquery-decorrelation` (25). Rationale: predicate pushdown enriches Filter-derived ECs on the
aggregate's source first; the smaller GROUP BY then feeds `ruleAggregatePhysical` (Physical pass,
priority 20), which may swing the stream/hash decision because the new sort key is shorter.

Target node type: **`PlanNodeType.Aggregate`** only. The rule fires before physical conversion to
Stream/Hash aggregate, so we don't need to handle those node types directly.

### Rule logic

```
ruleGroupByFdSimplification(node, ctx):
  if !(node instanceof AggregateNode): return null
  if node.groupBy.length <= 1: return null

  Build groupByMap: outIdx → ColumnReferenceNode for each bare-column GROUP BY
  if groupByMap.size <= 1: return null     // < 2 simplifiable columns → nothing to do

  Read aggregate's own physical.fds + physical.equivClasses (these are already projected
  onto output indices by propagateAggregateFds).

  Expand ECs into bi-directional FDs:
    for each EC [c0, c1, ..., ck]:
      emit {determinants:[c0], dependents:[c1..ck]} and reverse direction(s) as needed
      (in practice: for each pair (ci, cj), {ci}→{cj})
  Combine with physical.fds.

  candidateSet = { outIdx : gi is bare ColumnReferenceNode }     // expression GROUP BYs untouched
  cover = minimalCover(candidateSet, combinedFds)

  dropped = candidateSet \ cover
  if dropped.size == 0: return null

  Build new AggregateNode (see "Schema-preserving rewrite" below).
```

`minimalCover` from `planner/util/fd-utils.ts` already exists from the foundation ticket.

### Schema-preserving rewrite (picker-aggregate strategy)

The aggregate's *output* attributes must keep the same IDs so downstream `ColumnReferenceNode`s
still bind. Position can change — every downstream consumer resolves columns by attribute ID.

Layout transformation:

```
Before (N kept + D dropped + M aggs):
  groupBy:     [g_k0, g_drop0, g_k1, g_drop1, ...]                  // mixed kept/dropped, original order
  aggregates:  [agg_0, agg_1, ..., agg_{M-1}]
  attrs:       [gbAttr_0, gbAttr_1, ..., gbAttr_{N+D-1}, aggAttr_0, ..., aggAttr_{M-1}]

After:
  groupBy:     [g_k0, g_k1, ...]                                    // kept only, original relative order
  aggregates:  [MIN(g_drop0) AS pickerAttr_0_name,
                MIN(g_drop1) AS pickerAttr_1_name,
                ...,
                agg_0, agg_1, ..., agg_{M-1}]
  attrs:       [keptGbAttrs..., droppedGbAttrs (REUSED), origAggAttrs...]
```

The crucial preservation: the *attribute IDs* of the dropped GROUP BY columns are reused for
the picker aggregate output positions. Names and types come from the original attribute.

`AggregateNode.buildAttributes()` honors `preserveAttributeIds` — pass the re-ordered list
through and the new node's `getAttributes()` returns IDs verbatim.

### Synthesizing the picker MIN aggregate

`AggregateFunctionCallNode` (in `planner/nodes/aggregate-function.ts`) wants:
- `expression: AST.FunctionExpr` — synthesize `{ type: 'function', name: 'min', args: [<ast-placeholder>], distinct: false }`.
  The `args` AST entry is unused at execution (the planner uses the `ScalarPlanNode` args), so
  a stub `LiteralExpr` is acceptable; check what existing code paths pass when re-wrapping
  (`function-call.ts:94`).
- `functionName: 'min'`
- `functionSchema: ctx.db._findFunction('min', 1)` — look up via `OptContext.db`. The rule
  receives `OptContext`; access `db` off it.
- `args: [originalGroupByExpr]` — the original `ColumnReferenceNode` from the dropped GROUP BY.
- `isDistinct: false`
- The aggregate's output `Attribute.type` should be the original column's type (which equals
  `MIN(col).getType()` since MIN preserves its input type modulo nullability, and we use
  `preserveAttributeIds` so the type comes from the original attr anyway).

### Aggregate-output FDs already capture the structure we need

`propagateAggregateFds` (in `aggregate-node.ts:29`) projects source FDs/ECs through the
GROUP BY map, producing aggregate-output FDs in output column indices `0..groupCount-1`.
This is exactly the input to `minimalCover` — no extra source-side reasoning needed.

Aggregate output FDs:
- Include `key → others` from the source's keys (PK/UNIQUE) where every column maps to a
  bare-column GROUP BY output.
- Include `col1 ↔ col2` pairs from filter-derived ECs where both columns are bare-column
  GROUP BYs.
- Include FK→PK FDs once the FK-derived FD ticket lands (out of scope here).

### Edge cases & safety gates

- **Expression GROUP BYs**: a `gi` that is not a `ColumnReferenceNode` is never in `candidateSet`,
  so `minimalCover` will never drop it. It stays as-is in `newGroupBy`. The rule's grouping-key
  count check uses the bare-column count, not `groupBy.length`.
- **NULL semantics**: aggregate-output FDs are already conservative — they only survive for
  bare-column GROUP BYs, and EC-derived FDs from `WHERE a = b` are sound because the filter
  excludes any row with NULL on either side, so all surviving rows have equal values.
  Key-derived FDs are sound because PK/UNIQUE-NOT-NULL columns are non-null. The remaining
  nullable-UNIQUE case is inherited from the foundation ticket — not introduced here.
- **HAVING with dropped columns**: HAVING sits in a `FilterNode` above the aggregate that
  references aggregate output by attribute ID. Since the picker preserves IDs, HAVING binds
  unchanged.
- **ORDER BY with dropped columns**: same — outer Project/Sort uses IDs.
- **Empty GROUP BY**: guarded by `groupBy.length <= 1` check.
- **Single bare-column GROUP BY**: nothing to drop; early return.

### Interaction with `ruleAggregatePredicatePushdown`

That rule reads `agg.physical.fds` to widen its set of pushable columns. Both rules use the
*aggregate's own* FD set on output indices, so they don't conflict — running this rule first
just gives the predicate-pushdown rule a (possibly) smaller groupBy to work over, with FDs
recomputed (still correct).

### Interaction with `ruleAggregatePhysical`

`ruleAggregatePhysical` (Physical pass) runs *after* this rule. Smaller GROUP BY means:
- `isOrderedForGrouping` check against source ordering can succeed where it would have failed.
- Sort cost in the cost comparison drops.
- Hash cost benefits slightly (fewer hash key components).

No code change needed in that rule.

## Files

- **`planner/rules/aggregate/rule-groupby-fd-simplification.ts`** (new) — rule implementation
  per the algorithm above. Mirrors the style of `rule-aggregate-predicate-pushdown.ts` for
  the rebuild-aggregate pattern. Logger `optimizer:rule:groupby-fd-simplification`.
- **`planner/optimizer.ts`** — register the rule in `registerRulesToPasses()`:
  ```ts
  this.passManager.addRuleToPass(PassId.Structural, {
      id: 'groupby-fd-simplification',
      nodeType: PlanNodeType.Aggregate,
      phase: 'rewrite',
      fn: ruleGroupByFdSimplification,
      priority: 23,
  });
  ```
- **`planner/nodes/aggregate-node.ts`** — no behavioral change; the rule consumes the existing
  `preserveAttributeIds` constructor parameter. (No edit unless a small helper is needed for
  attribute re-ordering.)
- **`planner/util/fd-utils.ts`** — optional: extract an `expandEcsToFds(ecs)` helper if the
  inline expansion in the rule is more than a few lines. Otherwise leave it inline.

## Tests

### Unit tests — `test/optimizer/rule-groupby-fd-simplification.spec.ts` (new)

Use the `query_plan(?)` TVF (same harness as `fd-propagation.spec.ts` /
`fd-equivalence.spec.ts`) to inspect the post-optimizer plan tree. Key cases:

- **PK-driven drop**: `CREATE TABLE c(id INT PRIMARY KEY, name TEXT, email TEXT);`
  `SELECT id, name, email FROM c GROUP BY id, name, email` →
  expected post-rule: `GROUP BY id` with two `MIN(...)` picker aggregates.
- **EC-driven drop**: `SELECT a, b, count(*) FROM t WHERE a = b GROUP BY a, b` →
  expected: `GROUP BY a` (or `b`) with one picker; same row count as un-simplified.
- **Negative — no FD or EC relating**: `GROUP BY a, b` where `a, b` are independent →
  rule does not fire.
- **Negative — expression GROUP BY**: `GROUP BY a+1, b` → rule skips (no bare-column drop
  available even if `a → b`).
- **Join + FK shape** (when FK-derived FDs ticket lands): assert simplification on
  `SELECT c.id, c.name, sum(o.total) FROM customers c JOIN orders o ON o.cid = c.id GROUP BY c.id, c.name`
  (note this currently won't fire without the FK-FD ticket — guard the assertion or skip it).
- **Single column GROUP BY**: rule does not fire.
- **Attribute-ID preservation**: assert that the rewritten aggregate's output attribute IDs
  match the original aggregate's output attribute IDs position-by-position (after the rewrite's
  re-ordering — IDs survive, positions may shift).
- **Stream/Hash interaction**: after the rule fires, `ruleAggregatePhysical` is allowed to
  choose either; assert the resulting plan node is a `StreamAggregateNode` or
  `HashAggregateNode` and its `groupBy.length` equals the simplified count.

### SQL-logic tests — `test/logic/07-aggregates.sqllogic` (extend)

Append a small section (use existing patterns in the file):

```
# GROUP BY FD simplification — PK-driven
statement ok
CREATE TABLE c(id INT PRIMARY KEY, name TEXT, email TEXT);

statement ok
INSERT INTO c VALUES (1, 'a', 'a@x'), (2, 'b', 'b@x'), (3, 'b', 'b@y');

query III rowsort
SELECT id, name, email FROM c GROUP BY id, name, email
----
1  a  a@x
2  b  b@x
3  b  b@y

# Same query, EC-derived
query III rowsort
SELECT id, name, email FROM c WHERE id = id GROUP BY id, name, email
----
... (same rows)
```

The point: result-row equality with the un-simplified semantics. No `plan` directive is
required at this layer — the optimizer test file carries the plan-shape assertions.

## Documentation

- **`docs/optimizer.md`** — under "Aggregation" rule catalog add a `groupby-fd-simplification`
  entry: priority 23, Structural pass, target `Aggregate`. Cite the FK-join-then-aggregate
  example. Cross-reference the FD framework section.
- No `docs/architecture.md` change needed.

## Out of scope (deferred)

- Expression-grouping simplification (`GROUP BY x+1, x+2`). Requires injective-pair reasoning
  beyond the single-attribute injectivity already wired.
- `DistinctNode` analogue — `DISTINCT a, b WHERE a = b` → `DISTINCT a`. Same idea; small
  follow-up ticket.
- Picking the *cheapest* cover (e.g., prefer narrower types as the kept column). For now we
  use whatever `minimalCover`'s greedy returns — deterministic but not cost-aware.

## TODO

Phase 1 — rule implementation

- Create `planner/rules/aggregate/rule-groupby-fd-simplification.ts` with `ruleGroupByFdSimplification`.
- Implement the algorithm: candidate set from bare-column GROUP BYs, EC-to-bi-FD expansion,
  `minimalCover` call, dropped-set detection.
- Implement picker-aggregate synthesis: look up `min/1` schema from `ctx.db._findFunction`,
  synthesize `AST.FunctionExpr` stub, construct `AggregateFunctionCallNode`.
- Implement the rebuild: assemble new `groupBy`, new `aggregates`, re-ordered `preserveAttributeIds`,
  return `new AggregateNode(...)` preserving cost override of `undefined` (let it recompute).
- Register the rule in `planner/optimizer.ts` at Structural priority 23.

Phase 2 — tests

- Add `test/optimizer/rule-groupby-fd-simplification.spec.ts` covering the cases above.
- Append the `07-aggregates.sqllogic` section.
- Run `yarn workspace @quereus/quereus run lint` and `yarn test` (foreground, `tee` to a log).
  Expect no regressions in existing aggregate / FD propagation tests.

Phase 3 — docs

- Update `docs/optimizer.md` rule catalog and FD framework section.
