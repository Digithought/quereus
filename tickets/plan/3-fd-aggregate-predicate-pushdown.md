---
description: Push WHERE predicates from above an aggregate down to below it when the predicate references only FD-determined columns
prereq: fd-property-foundation, fd-from-equivalence-classes
files:
  - packages/quereus/src/planner/rules/predicate/rule-aggregate-predicate-pushdown.ts (new)
  - packages/quereus/src/planner/framework/registry.ts
  - packages/quereus/src/planner/nodes/aggregate-node.ts
  - packages/quereus/src/planner/nodes/stream-aggregate.ts
  - packages/quereus/src/planner/nodes/hash-aggregate.ts
  - packages/quereus/test/optimizer/rule-aggregate-predicate-pushdown.spec.ts
  - packages/quereus/test/logic/06-aggregates.sqllogic
  - docs/optimizer.md
---

## Motivation

Predicates on GROUP BY columns can always be pushed below the aggregate: filtering rows before grouping produces the same groups (minus any group whose members are entirely filtered out) and is strictly faster. The existing `rulePredicatePushdown` recognizes some commuting cases but is conservative about aggregates.

With FD knowledge, the push-down opportunity widens. A predicate that references a column functionally determined by a GROUP BY column is equivalent to a predicate on the GROUP BY column itself. Today the planner only allows pushdown when the predicate directly references a GROUP BY column; the FD-aware version handles indirect determination.

```sql
-- Original: filter applied to grouped output
SELECT customer_id, sum(total)
FROM (SELECT o.customer_id, c.region, o.total
      FROM orders o JOIN customers c ON o.customer_id = c.customer_id) j
WHERE j.region = 'EU'
GROUP BY j.customer_id;

-- With FD pushdown (customer_id → region via the FK PK constraint):
-- The predicate on region can apply before the GROUP BY.
-- Even better: with predicate inference (rule-predicate-inference-equivalence),
-- the filter ultimately lands on customers.region directly.
```

The bigger payoff is HAVING-clause pushdown:

```sql
SELECT customer_id, sum(total) FROM orders GROUP BY customer_id HAVING customer_id > 100;
-- HAVING customer_id > 100 references a GROUP BY column.
-- Pushing it to WHERE filters before grouping.
```

That second case is technically already pushdownable without FD knowledge (any predicate on a GROUP BY column commutes), but the existing pushdown rule doesn't yet do it. This ticket lands both pieces under one rule.

## Architecture

### Rule placement

`ruleAggregatePredicatePushdown` in `planner/rules/predicate/`. Registered in the Structural pass. Operates on `FilterNode` whose source is an `AggregateNode` (`StreamAggregateNode` or `HashAggregateNode`).

### Algorithm

For a `FilterNode(predicate, AggregateNode(source, groupBy, aggregates))`:

1. Decompose `predicate` into a conjunction of conjuncts.
2. For each conjunct:
   - Walk its column references and check that every referenced column is in `closure(groupBy, source.fds, source.equivClasses)`. If so, the conjunct is purely on grouping-determined columns and can be pushed below the aggregate.
   - If any referenced column is an aggregate-output column (e.g. `sum(total) > 1000`), the conjunct must remain above — aggregates cannot be evaluated pre-grouping.
3. Partition the conjuncts into "pushable" and "must-remain-above."
4. Rebuild:
   - Below the aggregate: `FilterNode(pushable_conjunction, original_source)`.
   - Above the aggregate: `FilterNode(remaining_conjunction, new_aggregate)` — omit if no remaining.

### Mapping column references through the aggregate boundary

The aggregate's output columns are not all source columns. GROUP BY output columns map directly to source attributes (via the existing GROUP BY column → source-attribute mapping in `aggregate-node.ts`). Pushable predicates reference these mapped attributes, which require attribute-id remapping when constructing the below-aggregate filter:

- Each `ColumnReferenceNode` in the pushable conjunct points at an aggregate-output attribute. The rule rewrites it to point at the underlying source attribute. The mapping is well-defined for GROUP BY output columns; aggregate output columns (sum/count/etc.) are explicitly disqualified by step 2.

### NULL handling

`SUM`, `COUNT`, etc. have idiosyncratic NULL behavior, but those are aggregate-output columns and don't participate in this rule. GROUP BY columns retain their value through the aggregate, so filtering on them at the source level produces identical results.

### HAVING is just Filter-above-Aggregate

The optimizer represents `HAVING` as a `FilterNode` directly above an `AggregateNode`. So this rule handles HAVING clauses transparently — there's no separate "HAVING pushdown" rule needed.

### Interaction with predicate-inference

When the EC machinery has propagated equalities through the join inside an aggregate, the inferred predicates above the aggregate may reference columns FD-determined by the GROUP BY. This rule then pushes them through. The two rules compose naturally.

## Use cases enabled

- HAVING clauses on GROUP BY columns are pre-filtered before grouping work.
- View materializations with aggregates plus outer filters get filtered before aggregation.
- Combined with EC inference, OLAP-style queries get *much* less data into the aggregation step.

## Tests

- Unit test: `WHERE customer_id > 100` above `GROUP BY customer_id` is pushed below the aggregate.
- Unit test: `HAVING customer_id > 100` (parses to the same Filter-above-Aggregate shape) is pushed.
- Unit test: `HAVING sum(total) > 1000` is NOT pushed (references aggregate output).
- Unit test with FD: `WHERE region = 'EU'` above `GROUP BY customer_id` where `customer_id → region` via FD is pushed below.
- Plan-shape test: the Filter node moves from above to below the aggregate.
- Logic test: result rows identical before/after the rule fires.

## Documentation

- **docs/optimizer.md** — add a rule catalog entry under "Predicate". Cross-reference from the FD framework section.
- No `docs/architecture.md` change required.

## Out of scope

- Aggregate pushdown (moving the aggregate itself below a join), which is a different optimization tracked by `tickets/backlog/3-aggregate-pushdown.md`. This rule moves predicates around; that one moves aggregates around.
- Partial aggregate pushdown — aggregate the predicate-filtered subset, combine with the unfiltered subset's aggregate — too speculative without strong cost information.
