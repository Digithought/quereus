description: Teach the fan-out lookup-join recognition rule to accept aggregate-shaped correlated subqueries as at-most-one branches, so per-row JSON/scalar aggregations get driven concurrently alongside the row's other lookups. Subsumes the former `array` branch mode — no new node mode or emitter path is needed.
prereq: parallel-fanout-lookup-join-rule
files: packages/quereus/src/planner/rules/join/rule-fanout-lookup-join.ts, packages/quereus/src/planner/nodes/fanout-lookup-join-node.ts, packages/quereus/src/func/builtins/json.ts
----

## Background — why there is no `array` branch mode

The original `…-array-cross-modes` backlog ticket proposed an `array` branch mode that packed a branch's many rows into a single JSON-array column. That is not a relational join mode — it is nested-value construction. Expressed in SQL it is an ordinary correlated aggregate:

```sql
select o.*,
       (select json_group_array(json_object('id', l.id, 'qty', l.qty))
        from lineitems l where l.order_id = o.id) as lines
from orders o;
```

A correlated scalar aggregate with no `GROUP BY` produces **exactly one row per outer row**, so the branch is already an `atMostOne` branch that `FanOutLookupJoinNode` v1 emits correctly. `json_group_array` is a streaming aggregate (`func/builtins/json.ts`) — it folds rows into the array in a single pass, so there is no product, no replay, and no `CacheNode`. The JSON shape (objects vs arrays) is whatever the query expresses; the engine never chooses it.

So the only missing piece is **recognition**: the v1 rule (`parallel-fanout-lookup-join-rule`) walks an FK→PK nested-loop chain and does not currently route a correlated-aggregate subquery branch through the fan-out node.

## Scope

Extend `rule-fanout-lookup-join` (or a sibling recognition pass) so that a correlated subquery branch whose root is a scalar/grouped aggregate keyed to the outer correlation is recognized as an at-most-one branch and clustered for concurrent drive, subject to the existing `expectedLatencyMs` cost gate. No change to `FanOutBranchMode`, the emitter, or any output-shaping logic.

## Out of scope

- Any new node mode or emitter path. If recognition needs richer branch metadata, add it to `FanOutBranchSpec`, not a new `FanOutBranchMode`.
- The relational 1:n product case — that is `parallel-fanout-lookup-join-cross-mode`.

## Open questions

- Whether such branches are best recognized in this rule directly, or as a generalization of subquery decorrelation that feeds the existing rule. Decide during plan.

## End
