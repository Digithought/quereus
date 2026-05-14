---
description: Optimizer rule that drops GROUP BY columns that are functionally determined by other remaining GROUP BY columns
prereq: fd-property-foundation, fd-from-injective-projections, fd-from-equivalence-classes
files:
  - packages/quereus/src/planner/rules/aggregate/rule-groupby-fd-simplification.ts (new)
  - packages/quereus/src/planner/framework/registry.ts
  - packages/quereus/src/planner/nodes/aggregate-node.ts
  - packages/quereus/src/planner/nodes/stream-aggregate.ts
  - packages/quereus/src/planner/nodes/hash-aggregate.ts
  - packages/quereus/test/optimizer/rule-groupby-fd-simplification.spec.ts
  - packages/quereus/test/logic/06-aggregates.sqllogic
  - docs/optimizer.md
---

## Motivation

`GROUP BY` columns determine the grouping granularity. When one grouping column is functionally determined by another (or by the input table's keys), the dependent column is redundant — including it in GROUP BY costs hash slots, comparison work, and (for stream aggregate) sort cost, but doesn't change the result.

Classic examples:

```sql
-- customer_id is a PK on customers; customer_name and customer_email are FDs from customer_id.
-- The query below groups on three columns when one would suffice.
SELECT c.customer_id, c.customer_name, c.email, sum(o.total)
FROM customers c JOIN orders o ON o.customer_id = c.customer_id
GROUP BY c.customer_id, c.customer_name, c.email;

-- After rule: GROUP BY c.customer_id
```

```sql
-- After predicate inference: a = b is an EC, so GROUP BY a, b can drop b
SELECT a, b, count(*) FROM t WHERE a = b GROUP BY a, b;
```

Without this rule the planner pays for redundant grouping work on every query that joins through an FK and projects parent attributes alongside the grouping key — a *very* common shape.

## Architecture

### Rule placement

A new rule `ruleGroupByFdSimplification` in `planner/rules/aggregate/`. Registered in the **Structural pass** (priority TBD, somewhere between `predicate-pushdown` at 20 and `subquery-decorrelation` at 25 — the rule consumes EC info that filter-pushdown's predicates may have produced, but it must run before physical aggregate selection which decides stream vs hash).

Actually the safer placement is **after the EC-deriving rules have populated the source's `fds`/`equivClasses`** — practically that means running in a late Structural sub-pass or early in the Physical pass before `ruleAggregatePhysical`. Final placement is an implementation detail; the rule itself doesn't care about pass order beyond "source FD/EC properties must be computed."

### Algorithm

For a `(Stream|Hash)AggregateNode` with GROUP BY expressions `G = [g0, g1, …, gN]`:

1. Skip if `|G| ≤ 1` — no simplification possible.
2. Skip if any `gi` is a non-trivial expression (not a `ColumnReferenceNode` and not provably constant). The rule operates on column-reference grouping columns; expression-grouping is deferred.
3. Resolve each `gi` to its source attribute id `aI`. Let `A = { aI }`.
4. Pull source FDs and ECs from `aggregate.source.physical`.
5. Compute `minimalCover(A, fds, ecs)` — the smallest subset `M ⊆ A` whose closure equals `closure(A)`. (Defined in the `fd-property-foundation` ticket.)
6. If `|M| < |A|`, rebuild the aggregate node with `G' = [gi : aI ∈ M]`. The aggregate output schema does *not* change — dropped grouping columns still appear in the output, but they're computed as `MIN(gi)` (or a similar trivial aggregate) over their group because they're constant within the group.

Step 6 is the tricky part. There are two equally valid output strategies:

- **Aggregate-output strategy**: keep the output schema identical by adding `MIN(gi)` (or any single-row picker) for each dropped column. This works for both stream and hash aggregate emitters. Cost: one extra trivial aggregate per dropped column.
- **Project-wrap strategy**: emit only the minimal grouping columns from the aggregate, then wrap the aggregate in a `ProjectNode` that re-emits the original output schema by computing the dropped columns from the kept ones via `FunctionalDependency` mapping. Requires knowing *which* FDs produced the determination — feasible (track the FD lineage during `minimalCover`) but more plumbing.

Recommended: **aggregate-output strategy**. Simpler, requires no FD lineage tracking. The MIN/MAX picker has trivial cost since each group has one value to pick from.

### Edge cases

- **NULL handling in GROUP BY**: SQL treats `NULL = NULL` as true in GROUP BY (distinct-from `NULL = NULL` in WHERE returning NULL). FDs derived from non-null PKs are fine; FDs derived from arbitrary columns may have a NULL caveat. Conservative gate: only apply the rule when the determinant columns are NOT NULL or the FD source was a key (keys imply non-null determinants except where the schema allows NULL primary keys, which is unusual).
- **HAVING with dropped columns**: a HAVING predicate referencing a dropped column still works — the column is still produced (via the picker aggregate). No additional handling needed.
- **ORDER BY with dropped columns**: same — the output schema is unchanged.
- **GROUP BY () (empty)**: not affected — singleton aggregate case.

### Interaction with existing aggregate selection

`ruleAggregatePhysical` decides stream vs hash based on whether the input is already sorted on the grouping columns. After this rule fires, the grouping column set is smaller, which could change the decision. Ordering: this rule runs **before** `ruleAggregatePhysical`. That's a natural fit since `ruleAggregatePhysical` is already a Physical-pass rule.

## Use cases enabled

- Cleaner aggregate plans for common FK-join-then-aggregate shapes (the prototypical OLAP query).
- Faster aggregation on wide GROUP BY lists where most columns are FDs of one key column.
- Better stream-aggregate eligibility: fewer GROUP BY columns means a shorter sort key, which more often matches existing source ordering.

## Tests

- A unit test asserting that `GROUP BY c.id, c.name` (where `c.id` is PK and `c.name` is a non-key column) reduces to `GROUP BY c.id`.
- A SQL logic test in `06-aggregates.sqllogic` asserting that the simplified query produces identical results to the original.
- A negative test asserting that `GROUP BY a, b` *without* an EC or FD relating them is left alone.
- A plan-shape test on a join-then-aggregate query asserting the resulting GROUP BY has been reduced.
- An interaction test with `WHERE a = b GROUP BY a, b` — the EC from the filter should cause `b` to be dropped from GROUP BY.

## Documentation

- **docs/optimizer.md** — add a rule catalog entry under "Aggregation" describing the new rule. Add a paragraph in the FD framework section showing the example.
- No `docs/architecture.md` change required.

## Out of scope

- Expression-grouping simplification (e.g. `GROUP BY x+1, x+2`). Doable in principle if both expressions are injective in `x`, but adds substantial reasoning complexity. Deferred.
- DISTINCT-style equivalent simplification on `DistinctNode` — `DISTINCT a, b WHERE a = b` should drop `b`. Same idea; can ride alongside this rule or be a small follow-up.
