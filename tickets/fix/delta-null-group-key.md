---
description: 'group' bindings whose group-key column is NULL are silently never re-evaluated by the DeltaExecutor — the injected predicate `col = :gk0` evaluates UNKNOWN against NULL, so the residual matches no rows and the assertion check is silently skipped for the NULL group.
prereq:
files:
  - packages/quereus/src/core/database-assertions.ts
  - packages/quereus/src/planner/analysis/binding-extractor.ts
  - packages/quereus/test/logic/95-assertions.sqllogic
---

## Problem

`AssertionEvaluator.injectKeyFilter` rewrites the residual to filter the
target `TableReferenceNode` with `col_i = :gk{i}` for each group-key column.
When a row's group-key column value is NULL, three things conspire to lose
the assertion check:

1. The row's NULL is captured into the OLD/NEW projection by
   `TransactionManager.recordInsert/Update/Delete`.
2. `DeltaExecutor` packages that NULL into the `perRelationTuples` batch and
   `executeResidualPerTuple` binds it as `params.gk0 = null`.
3. The residual evaluates `col = NULL` → UNKNOWN. SQL filters out UNKNOWN,
   so the residual scan returns zero rows. The aggregate sees no input. The
   outer existence/violation predicate sees no violation. The assertion
   silently passes for the NULL group even when the actual group is in
   violation.

This is benign for `'row'` bindings on PK (PKs cannot be NULL) but is a
real correctness gap for `'group'` bindings on any nullable column. SQL
`GROUP BY` treats NULL as a distinct group, so a NULL group can have rows
and can violate constraints.

## Repro sketch

```sql
CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NULL, qty INTEGER);
CREATE ASSERTION orders_nonneg CHECK (NOT EXISTS (
  SELECT 1 FROM (SELECT customer_id, SUM(qty) AS s FROM orders GROUP BY customer_id) WHERE s < 0
));
INSERT INTO orders VALUES (1, NULL, -100);
COMMIT;
-- Expected: assertion fails for the NULL group.
-- Actual:   commit succeeds; the per-group residual `customer_id = NULL` matches nothing.
```

The classification is `'group'` with `groupColumns = [customer_id_index]`.
The captured tuple is `[null]`. The bound residual checks `customer_id = NULL`,
which is never true.

## Fix options

1. **`IS NOT DISTINCT FROM`-style predicate.** Replace the `col = :gk{i}`
   conjuncts with `(col IS NULL AND :gk{i} IS NULL) OR col = :gk{i}`. This
   is straightforward at the AST level but produces a less-friendly plan
   (no equi-join inference, may interfere with index pushdown).
2. **Two-track dispatch.** When a captured tuple contains any NULL, run a
   distinct residual variant whose predicate is `col IS NULL` for the NULL
   columns and `col = :gk{i}` for the rest. Pre-compile both. Most commits
   touch only non-NULL groups, so the NULL-track residual is cold.
3. **Null sentinel + post-filter.** Bind a sentinel value, run the residual
   with `col = :gk{i}`, and post-filter results in code. Avoids planner
   complications but bypasses index lookups entirely.

Option (1) is the simplest correctness fix. The optimizer can still recognize
the disjunction as equivalent to `col IS NOT DISTINCT FROM :gk{i}` if/when
that operator lands; until then, the cost penalty is small (group sizes are
typically small relative to the table).

## Tests to add

- Append to `packages/quereus/test/logic/95-assertions.sqllogic`: the repro
  above plus a passing-case variant.
- Unit-level test that drives the residual through a NULL parameter and
  confirms it matches the NULL-grouped rows.

## Notes

This was identified during review of
`tickets/complete/4-fd-view-maintenance-binding-keys.md` (review findings
section) but separated because the planner-level fix touches more than the
review pass should.
