description: Extend the fan-out lookup-join recognition rule to also cluster correlated scalar-aggregate subqueries (in the SELECT projection list) as at-most-one fan-out branches, so per-row JSON/scalar aggregations drive concurrently alongside the outer row's other lookups. No new node mode or emitter path.
prereq: parallel-fanout-lookup-join-rule
files: packages/quereus/src/planner/rules/join/rule-fanout-lookup-join.ts, packages/quereus/src/planner/nodes/fanout-lookup-join-node.ts, packages/quereus/src/planner/nodes/subquery.ts, packages/quereus/src/planner/nodes/aggregate-node.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/planner/cache/correlation-detector.ts, packages/quereus/src/planner/framework/characteristics.ts, packages/quereus/test/optimizer/parallel-fanout.spec.ts, docs/optimizer.md
----

## Goal

`FanOutLookupJoinNode` v1 already emits `atMostOne` branches correctly. The only missing
piece is **recognition**: a correlated scalar-aggregate subquery in a SELECT projection is,
relationally, an at-most-one branch driven per outer row — exactly what the fan-out node
drives concurrently. Teach `ruleFanOutLookupJoin` to recognize that shape and cluster it
(alongside any FK→PK join-spine branches) into a single `FanOutLookupJoinNode`.

Motivating query (per-row JSON aggregation alongside scalar lookups):

```sql
select o.*,
       (select json_group_array(json_object('id', l.id, 'qty', l.qty))
        from lineitems l where l.order_id = o.id)   as lines,
       (select count(*) from payments p where p.order_id = o.id) as n_pay
from orders o;
```

Both subqueries are correlated scalar aggregates with no `GROUP BY`. A scalar aggregate
emits **exactly one row** per outer row regardless of how many child rows match (aggregate
of the empty set is still one row — `count→0`, `json_group_array→null`). So each is an
`atMostOne-left` branch. `json_group_array` (`func/builtins/json.ts`) is a streaming
aggregate — one pass, no product, no `CacheNode`. The JSON shape is whatever the query
expresses; the engine never chooses it. This subsumes the former proposed `array` branch
mode entirely — there is **no** new `FanOutBranchMode`.

## Open question — resolved

> Recognize in this rule directly, or as a generalization of subquery decorrelation that
> feeds the rule?

**Decide: recognize directly in `ruleFanOutLookupJoin`.** Generic decorrelation of a scalar
aggregate would rewrite to `outer LEFT JOIN (select fk, agg(...) from child group by fk)` —
a build-side hash aggregate. That *defeats* this ticket: it forces a materialized group-by
and loses the per-row streaming concurrency, and introduces exactly the product/replay the
ticket says must not happen. The fan-out node already drives correlated per-row branches
with isolated `RowSlot`s via fork snapshots — the subquery's relational root can be used
**as-is** as a branch `child`; only the projection's scalar reference is rewritten to a
column reference. So this is fan-out-targeted recognition, not generic decorrelation. The
existing `rule-subquery-decorrelation.ts` (WHERE-clause EXISTS/IN → semi/anti join) is a
different path and stays untouched.

## Architecture

### Current rule shape (`rule-fanout-lookup-join.ts`)

The rule fires on a `ProjectNode`, walks pass-through wrappers
(Filter/Sort/LimitOffset/Distinct/Alias) down to a `JoinNode`, descends the `.left` spine
collecting FK→PK lookup branches, builds one `FanOutLookupJoinNode(outer, branchSpecs[])`,
then rebuilds the wrappers + Project above it. It `return null`s immediately when
`node.source` (under wrappers) is **not** a `JoinNode` — so the pure-subquery case is never
reached today.

### Two branch kinds, one cluster

Generalize the rule so a cluster is the union of:

- **Join-spine branches** (existing): FK→PK lookups recognized along the `.left` spine. The
  outer is the deepest `.left`.
- **Subquery branches** (new): correlated scalar-aggregate `ScalarSubqueryNode`s found
  directly in `node.projections`.

The outer subtree is:

- the deepest `.left` of the join spine, when a spine exists; otherwise
- the bottom relational node beneath the chain wrappers (e.g. the `orders` access node for
  `select … from orders o`).

This requires restructuring the source walk so that hitting a non-`JoinNode`,
non-wrapper node is **not** an automatic bail — it just means zero spine branches and that
node is the outer. `extractTableSchema(outer)` (needed only for FK→PK alignment of spine
branches) is required **only when there are spine branches**; pure-subquery clusters skip it.

### Recognizing a subquery branch

New helper `recognizeSubqueryBranch(scalarSubquery, outerAttrs)`:

1. The projection's `node` must **be** a `ScalarSubqueryNode` directly (`proj.node instanceof
   ScalarSubqueryNode`). Do **not** dig into wrapping scalar expressions (`coalesce((subq),0)`,
   `json((subq))`) in v1 — defer (see backlog note below).
2. `isCorrelatedSubquery(scalarSubquery.subquery)` must be true (references an outer attr).
   Non-correlated scalar subqueries are constant-per-query — leave them alone.
3. Beneath pass-through wrappers (Project/Alias/Sort/LimitOffset) of `scalarSubquery.subquery`,
   the relational root must be **aggregate-shaped with no grouping keys**:
   `CapabilityDetectors.isAggregating(root) && root.getGroupingKeys().length === 0`. This
   matches both the logical `AggregateNode` and the physical `StreamAggregateNode` /
   `HashAggregateNode` (all implement `AggregationCapable`), so it is robust to optimizer
   pass ordering. Empty grouping ⇒ exactly one row per outer ⇒ at-most-one branch.
4. The subquery relational root (`scalarSubquery.subquery`) must expose **exactly one output
   attribute** (it is a scalar subquery). That attribute is the branch's single `outputAttr`.

Result: branch `child = scalarSubquery.subquery` (used verbatim — its own correlation filter
`child.fk = outer.key` is already inside it and resolves through `rctx.context`, the same
mechanism the join-spine branches' outer references use), `outputAttrs =
scalarSubquery.subquery.getAttributes()`, `mode = 'atMostOne-left'`, `concurrencySafe =
scalarSubquery.subquery.physical.concurrencySafe !== false`. No extra `FilterNode` wrapper
(unlike spine branches, whose ON-condition is wrapped in `FilterNode` — the subquery already
carries its correlation predicate internally).

`mode` is `'atMostOne-left'` deliberately: a scalar subquery in SELECT never removes the
outer row, and the aggregate always yields its one row, so the "zero-row → NULL fill" path of
`atMostOne-left` should never trigger — the branch's single finalized row carries the correct
value (`count→0`, not NULL). This is the decisive correctness invariant (see tests).

### Rewriting the projection

Unlike spine branches (which the surrounding Project already references by attribute ID),
each subquery branch requires **rewriting the projection expression**: replace the
`ScalarSubqueryNode` with a `ColumnReferenceNode` pointing at the branch's single output
attribute (the value now materialized in the FanOut's wide row). The Project keeps its own
output `attributeId` and `alias`; only the inner expression node changes from
`ScalarSubqueryNode` → `ColumnReferenceNode(branchOutputAttr, columnIndex)`. The
`columnIndex` is the branch attr's position in the FanOut wide layout
(`outer.length + Σ preceding-branch outputAttrs + 0`). Build the `ColumnReferenceNode` with
the branch attr's `type`, `id`, and that index (mirror how `rule-subquery-decorrelation.ts`
constructs `ColumnReferenceNode`s).

`rebuildProject` currently copies `p.node` verbatim. Extend it (or add a variant) to accept a
`Map<ScalarSubqueryNode, ColumnReferenceNode>` and substitute matching projection nodes.

### Wide-row layout / `preserveAttributeIds`

The FanOut layout stays `outer attrs + Σ branch.outputAttrs` in branch order. Order
join-spine branches first (preserving the existing left-deep order the spine path relies on),
then subquery branches. The new `ColumnReferenceNode`s resolve by **attribute ID** via the
row descriptor, so their position in the wide row is irrelevant to correctness — only the IDs
must line up, which they do because `outputAttrs` are the subquery roots' own attributes.
Build `preserveAttrs` exactly as today (outer, then each branch's outputAttrs, nullable-widened
for `atMostOne-left`).

### Cost gate (unchanged)

Same gate: `maxLatency = max(branch.child.physical.expectedLatencyMs)` across all branches
(spine + subquery); inert when 0 (no in-tree module declares latency). Subquery-branch
latency comes from the child table's `expectedLatencyMs` propagated up through the aggregate.
`minBranches` (default 2) still applies to the **combined** count — a lone subquery with no
other branch won't cluster (no concurrency win), which is correct.

## Scope

- Extend `ruleFanOutLookupJoin` recognition to cluster correlated scalar-aggregate subquery
  projections as `atMostOne-left` branches, combined with any FK→PK spine branches, subject to
  the existing `expectedLatencyMs` cost gate and `minBranches`.
- Support the no-join-spine case (pure subquery cluster: 2+ correlated scalar-aggregate
  subqueries over the same outer).

## Out of scope (park in backlog if you spot adjacent work)

- New `FanOutBranchMode` or emitter changes. If recognition needs richer per-branch metadata,
  add it to `FanOutBranchSpec`, not a new mode.
- Subqueries nested inside larger scalar expressions (`coalesce((subq),0)`, arithmetic on a
  subquery). Defer — v1 requires the projection node to *be* a `ScalarSubqueryNode`. If useful,
  file a backlog ticket `parallel-fanout-aggregate-branch-wrapped-subquery`.
- `GROUP BY` subqueries (may yield >1 row — not at-most-one). Must be rejected by the
  `getGroupingKeys().length === 0` gate.
- The relational 1:n product case — that is `parallel-fanout-lookup-join-cross-mode`.

## Key correctness invariants to verify

- **Empty-children value, not NULL.** `(select count(*) from child where child.fk=o.k)` for an
  outer row with no children must yield `0`, not `NULL`. The aggregate branch must be driven to
  its one finalized row; the `atMostOne-left` zero-row NULL-fill path must not fire.
- **Per-row correlation preserved.** Each outer row's branch sees only its own correlated
  child rows. Rule-enabled output must equal rule-disabled output, row-for-row.
- **Attribute-ID stability.** The rewritten Project exposes the same output attribute IDs /
  column shape as the un-rewritten plan (mirror the existing finding-1 attribute-ID test).

## TODO

### Phase 1 — recognition

- Restructure the source walk in `ruleFanOutLookupJoin` so a non-`JoinNode`/non-wrapper bottom
  yields `(outer = that node, spineBranches = [])` instead of bailing. Keep the existing
  wrapper collection (`ChainEntry[]`) intact.
- Gate `extractTableSchema(outer)` so it is required only when `spineBranches.length > 0`.
- Add `recognizeSubqueryBranch(scalarSubquery, outerAttrs)` per the rules above
  (`ScalarSubqueryNode` + `isCorrelatedSubquery` + aggregate-shaped/no-group-by root +
  single output attr). Use `CapabilityDetectors.isAggregating` from
  `framework/characteristics.ts` and skip Project/Alias/Sort/LimitOffset wrappers to reach the
  aggregate root.
- Scan `node.projections` for `ScalarSubqueryNode`s, run `recognizeSubqueryBranch` on each,
  collect the recognized subquery branches.

### Phase 2 — cluster assembly & projection rewrite

- Combine spine + subquery branches into one `branchSpecs[]` (spine first, then subqueries).
  Subquery branch `child` is the subquery root verbatim (no `FilterNode` wrap).
- Apply the combined-count `minBranches` check and the existing cost gate over `maxLatency`.
- Build the FanOut and `preserveAttrs` (outer + all branch outputAttrs, nullable-widening for
  `atMostOne-left`).
- For each subquery branch, construct a `ColumnReferenceNode` at the branch attr's wide-row
  index and build a `Map<ScalarSubqueryNode, ColumnReferenceNode>`.
- Extend `rebuildProject` to substitute those nodes in the projection list (keep each
  projection's own `attributeId`/`alias`).
- Rebuild chain wrappers above the FanOut as today.

### Phase 3 — tests (`test/optimizer/parallel-fanout.spec.ts`)

Reuse the existing `HighLatencyMemoryModule` + `concurrency: 2` tuning harness in that spec.
Add cases:

- **Pure subquery cluster fires.** `select o.k, (select json_group_array(a.v) from a where
  a.fk=o.k) x, (select count(*) from b where b.fk=o.k) y from outer_t o` against high-latency
  modules → plan contains `FANOUTLOOKUPJOIN` with 2 branches; both `atMostOne-left`.
- **Mixed cluster.** One FK→PK join branch + one correlated scalar-aggregate subquery → single
  `FANOUTLOOKUPJOIN` with 2 branches; output equals the join-elim/nested-loop baseline.
- **Result correctness (enabled vs disabled).** Same query with the rule disabled
  (`tuning.disabledRules`) vs enabled → identical rows. Include an outer row with **no**
  matching children to assert `count→0` (not NULL) and `json_group_array→null`.
- **Inert in-tree.** Same query against plain `memory` vtab (latency 0) → no `FANOUTLOOKUPJOIN`
  (cost gate inert), result still correct.
- **GROUP BY subquery rejected.** `(select … from a where a.fk=o.k group by a.cat)` → not
  routed into the fan-out (would be >1 row); plan has no `FANOUTLOOKUPJOIN` from that branch.
- **Non-correlated subquery not clustered.** `(select count(*) from a)` (no outer ref) → not
  recognized as a branch.
- **Attribute-ID stability.** Enabled vs disabled produce identical output column attribute
  IDs / shape (mirror finding-1 test at `parallel-fanout.spec.ts:259-285`).
- **Strict-fork.** Confirm `QUEREUS_FORK_STRICT=1` passes (use the `forkExecTest` skip guard
  already in the spec for execution-path cases).

### Phase 4 — validate & document

- `yarn workspace @quereus/quereus run test 2>&1 | tee /tmp/q.log; tail -n 60 /tmp/q.log`
  (Windows: `Tee-Object`). Then the focused spec, then `tsc --noEmit` and eslint on touched
  files (single-quote globs on Windows). Stream output; never silent-redirect.
- Update `docs/optimizer.md` § "Fan-out lookup join (FK→PK)" to document the
  aggregate-subquery branch recognition (what shape qualifies, the no-`GROUP-BY` requirement,
  that it subsumes the `array` mode and adds no new `FanOutBranchMode`). Touch `docs/runtime.md`
  only if the recognition surface description there needs it.

## Notes / gotchas

- The subquery's relational subtree may still be logical (`AggregateNode`) at structural-pass
  time or already physical (`StreamAggregateNode`) — `CapabilityDetectors.isAggregating`
  covers both. The optimizer continues optimizing the FanOut's branch children after the
  rewrite (they're exposed via `getChildren`/`getRelations`), so handing over the
  not-yet-physical subquery root is fine. Verify a `StreamAggregate` still appears under the
  fan-out branch in the resulting plan.
- Chain wrappers (`Filter`/`Sort`/`Alias`) between source-bottom and Project don't change
  outer attribute IDs (Alias re-labels but the subquery's correlated col refs target the base
  table's attr IDs), so `outer.getAttributes()` carries the correlated columns. Sanity-check
  with a `where`-filtered outer in a test.
- Mirror `rule-subquery-decorrelation.ts`'s `ColumnReferenceNode` construction pattern for the
  replacement refs (scope, expression reuse for formatting, type, attr id, column index).

## End
