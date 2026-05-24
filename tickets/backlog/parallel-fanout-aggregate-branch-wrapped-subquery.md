description: Extend fan-out subquery-branch recognition to correlated scalar aggregates nested inside a wrapping scalar expression (coalesce, arithmetic, json(), cast), not just a bare ScalarSubqueryNode projection.
files: packages/quereus/src/planner/rules/join/rule-fanout-lookup-join.ts, packages/quereus/test/optimizer/parallel-fanout.spec.ts, docs/optimizer.md
----

## Motivation

`ruleFanOutLookupJoin` recognizes a correlated scalar-aggregate subquery as an
`atMostOne-left` fan-out branch **only when the projection node IS a
`ScalarSubqueryNode`** (`recognizeSubqueryBranch`). Common shapes wrap the
subquery in a scalar expression and so are missed today:

```sql
select o.id,
       coalesce((select sum(l.qty) from lineitems l where l.order_id = o.id), 0) as total_qty,
       json((select json_group_array(p.id) from payments p where p.order_id = o.id)) as pay_ids
from orders o;
```

Here the projection node is a `FunctionCallNode` (`coalesce` / `json`) whose
argument is the `ScalarSubqueryNode`. Recognition should reach inside the
wrapping scalar expression, cluster the inner subquery as a branch, and rewrite
the *inner* `ScalarSubqueryNode` (not the whole projection) to a
`ColumnReferenceNode` into the fan-out wide row — leaving the wrapping
expression (`coalesce(<colref>, 0)`) intact.

## Scope / requirements

- Walk each projection's scalar expression tree to find a (single, for v1)
  correlated scalar-aggregate `ScalarSubqueryNode` that passes the existing
  `recognizeSubqueryBranch` gates (correlated, aggregate-shaped, no GROUP BY,
  one output column).
- Rewrite that inner node in place (rebuild the wrapping scalar expression with
  the subquery node substituted by a `ColumnReferenceNode`); the surrounding
  Project keeps its own output `attributeId`/`alias`.
- Multiple wrapped subqueries per projection, and a mix of wrapped + bare, may
  all cluster.
- No new `FanOutBranchMode`. Same cost gate / `minBranches` semantics.

## Out of scope

- Subqueries whose value feeds a position that changes cardinality (none for
  scalar context — a scalar subquery is always at-most-one).
- GROUP BY / multi-row subqueries (still rejected).

## Notes

The current bare-node path already wraps the subquery root in a stable
single-column `ProjectNode` to survive the logical→physical aggregate
attribute-count change (`AggregateNode` exposes 1 attr; `StreamAggregate`
exposes source columns too). Reuse that wrapping for the inner-node case.
