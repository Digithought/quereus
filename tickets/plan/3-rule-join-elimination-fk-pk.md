---
description: Optimizer rule that eliminates joins whose preserved side's columns are unused above the join and whose foreign-key relationship guarantees at-most-one match
prereq: fd-property-foundation, fd-from-equivalence-classes, fd-outer-join-key-preservation
files:
  - packages/quereus/src/planner/rules/join/rule-join-elimination.ts (new)
  - packages/quereus/src/planner/framework/registry.ts
  - packages/quereus/src/planner/nodes/join-node.ts
  - packages/quereus/src/planner/nodes/bloom-join-node.ts
  - packages/quereus/src/planner/nodes/merge-join-node.ts
  - packages/quereus/src/planner/util/key-utils.ts
  - packages/quereus/test/optimizer/rule-join-elimination.spec.ts
  - packages/quereus/test/logic/05-joins.sqllogic
  - docs/optimizer.md
---

## Motivation

Views and ORM-generated queries frequently emit joins that the caller doesn't actually consume. A typical pattern:

```sql
-- View defined as: orders LEFT JOIN customers ON orders.customer_id = customers.id
-- Caller only asks for order_id and total:
SELECT order_id, total FROM order_view;
```

The `customers` table is joined for nothing — no caller column from `customers` is projected, no predicate references `customers`. The join provides no information to the output.

For this rewrite to be sound:

1. No column from the eliminated side may be referenced above the join (projections, predicates, ORDER BY, GROUP BY).
2. The join cardinality must not change row count vs. the preserved side alone. For `LEFT JOIN orders → customers ON orders.customer_id = customers.id`, this requires:
   - The join key (`customers.id`) covers a unique key on `customers` (the PK).
   - The relationship is one-to-at-most-one — the FK `orders.customer_id → customers.id` plus the unique key guarantees this.
3. NULL semantics must be preserved. For LEFT JOIN with no FK enforcement on `orders.customer_id`, a missing customer still produces a null-padded right side; eliminating the join is safe because no right-side columns are read.

When all three hold, the join is dropped entirely and the preserved side bubbles up unchanged.

## Architecture

### Rule placement

`ruleJoinElimination` in `planner/rules/join/`. Registered in the Structural pass at priority ~24 (after predicate pushdown at 20, after the FD-deriving rules but before subquery decorrelation at 25). Operates on `JoinNode` (logical). After this rule, fewer joins remain for physical selection to choose algorithms for.

### Algorithm

For a logical `JoinNode(left, right, condition, joinType)`:

1. **Identify the candidate eliminated side**: the side whose columns are unused above. The other side is "preserved." For LEFT JOIN, only the right side is eliminable (the left's null-padding pattern requires it to always be emitted). For INNER JOIN, either side may be eliminable. For RIGHT JOIN, only the left. For FULL OUTER, neither (skip).
2. **Check column usage**: walk every consumer above the join. Required: no `ColumnReferenceNode` whose attribute id maps to a column from the eliminable side. Implemented by collecting all attribute ids referenced by the join's ancestors (predicates above, projections above, ORDER BY, GROUP BY, etc.) and intersecting with the eliminable side's attribute id set.
3. **Check cardinality preservation**: the join condition must cover a unique key on the eliminable side.
   - For LEFT JOIN: equi-pairs cover a unique key on the right.
   - For INNER JOIN eliminating the right: equi-pairs cover a unique key on the right *and* the join is "lossless" w.r.t. the left — i.e. every left row has a matching right row. This requires FK enforcement (or a nullable-cleaning predicate that the FK side's column is not null and matches). With unenforced FKs, INNER JOIN row elimination is unsafe.
4. **FK alignment check**: the equi-join's join columns on the eliminable side must align with that side's PK (or a UNIQUE), and the other side's columns must be the FK columns referencing it. `checkFkPkAlignment` (`planner/util/key-utils.ts:168`) already does this analysis; the rule consumes it directly.
5. **Eliminate**: replace the `JoinNode` with the preserved side. The join condition is dropped (it's enforced by FK semantics — or, if not, the condition was already redundant per the FK alignment).

### LEFT JOIN special case (most common)

For LEFT JOIN `A LEFT JOIN B ON A.fk = B.pk`:

- No B columns referenced above ⇒ pass.
- Equi-pair covers B's PK ⇒ pass.
- `A.fk → B.pk` is the FK relationship, declared on `A.fk`.

This combination is the most common shape in view-elimination scenarios. With this trio, the entire join collapses to just `A`.

### INNER JOIN safety

INNER JOIN eliminates left rows that have no matching right row. Even if no B columns are referenced, eliminating the join changes the row count when some A rows have NULL `fk` or unmatched `fk`. To eliminate INNER JOIN safely:

- The FK column on A is declared `NOT NULL` AND
- The FK constraint is enforced (not `OR IGNORE`, not a deferred FK with potential dangling references).

The schema-level check is straightforward: `TableSchema.foreignKeys` carries the declaration; `TableSchema.columns` has the NOT NULL flag. Both must align.

When the safety check fails, do not eliminate the INNER JOIN. (The LEFT JOIN case has no such restriction — null padding handles unmatched rows.)

### Equi-pair recovery

The rule needs the join condition's equi-pairs. Existing helpers in `planner/util/join-utils.ts` (already used by `analyzeJoinKeyCoverage`) extract these from an AND-of-equalities `ON` clause. Non-equi residual conjuncts disqualify the rule — they're conditions that reference the eliminable side beyond key equality.

### Plan transformation

```
JoinNode(left=A, right=B, condition=A.fk=B.pk, type=LEFT)
  └─ (no B references above)
       =>  A
```

If the join had a `RetrieveNode` wrapper for `B` (federation case), the entire `RetrieveNode` subtree is dropped — including any pushed-down predicates on `B`. That's safe because those predicates were only restricting B's rows for the (now-eliminated) join.

## Use cases enabled

- View elimination: select-only-some-columns over a view that joins extra tables → those joins disappear.
- ORM-generated queries: ORMs that always `JOIN` parent tables for FK fields produce smaller plans when the caller only selects child columns.
- Federation: dropping joins that touch remote tables reduces network round-trips dramatically.

## Tests

- Unit test: `SELECT order_id FROM orders LEFT JOIN customers ON orders.customer_id = customers.id` plan has no join.
- Unit test: same query, `SELECT order_id, customers.name` — the join is NOT eliminated.
- Unit test: same query, `WHERE customers.region = 'EU'` — the join is NOT eliminated.
- Unit test: INNER JOIN equivalent with NOT NULL FK declaration — eliminated.
- Unit test: INNER JOIN equivalent without FK enforcement (or nullable FK) — NOT eliminated.
- Logic test: result rows identical before/after the rule fires for the eliminable cases.
- Federation test: eliminated join across module boundaries does not emit a network call.

## Documentation

- **docs/optimizer.md** — add a rule catalog entry under "Join". Add a paragraph in the "Key-driven row-count reduction" / FK→PK section describing the elimination case.
- **docs/architecture.md** — extend the federation discussion in "Key Design Decisions" to note that FK-driven join elimination reduces federation traffic; cross-reference the optimizer doc.

## Out of scope

- Eliminating joins whose preserved-side columns are FD-determined by the eliminated side via the inverse FK direction. E.g. `orders JOIN customers ON ... GROUP BY orders.customer_id` — the GROUP BY reads the FK directly, so `customers` is unused, but the analysis to handle every variant of this is involved. The straightforward "no columns from eliminable side above" check handles the bulk of value; refinements are deferred.
- Multi-join elimination (cascading) — the rule runs to fixed-point naturally via the optimizer's structural pass, so a chain of eliminable joins is reduced one at a time.
