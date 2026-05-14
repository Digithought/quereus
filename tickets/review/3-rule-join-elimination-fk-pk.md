---
description: Review the FK→PK join-elimination optimizer rule that drops joins whose non-preserved side is never consumed above the join.
files:
  - packages/quereus/src/planner/rules/join/rule-join-elimination.ts (new)
  - packages/quereus/src/planner/optimizer.ts
  - packages/quereus/test/optimizer/rule-join-elimination.spec.ts (new)
  - packages/quereus/test/logic/11-joins.sqllogic
  - docs/optimizer.md
  - docs/architecture.md
---

## What was built

`ruleJoinElimination` — a structural-pass optimizer rule that detects and removes a `JOIN` whose non-preserved side is never referenced above the join and is at-most-one-matching per a declared FK→PK relationship. Registered on `PlanNodeType.Project` at priority **24** in the Structural pass (between `scalar-cse` at 22 / `groupby-fd-simplification` at 23 and `subquery-decorrelation` at 25).

### Algorithm

1. Fires on `ProjectNode`. Seeds the demanded-attribute-ID set from the projection expressions.
2. Walks down `node.source` through a whitelist of pass-through nodes (`Filter`, `Sort`, `LimitOffset`, `Distinct`, `Alias`), accumulating any attribute IDs those nodes reference in their predicates / sort keys.
3. Terminates at a `JoinNode`; bails on anything else.
4. Required join shape: `joinType ∈ {left, right, inner}`, condition exists, `extractEquiPairsFromCondition` returns ≥1 pair, AND the normalized condition is **AND-of-column-equalities only** (any non-equi residual disqualifies — those can alter cardinality beyond the FK→PK guarantee).
5. Classifies the demanded set against left/right attribute IDs. LEFT can only eliminate right; RIGHT only left; INNER may try either side.
6. Cardinality preservation via `checkFkPkAlignment` (`packages/quereus/src/planner/util/key-utils.ts:357`). The FK side is the preserved side; the PK side is the one being eliminated.
7. **INNER-JOIN extra guard**: every FK column on the preserved side must be `NOT NULL`. With nullable FKs, rows whose FK is NULL wouldn't match anything in the PK side under inner-join semantics, but would survive elimination — a row-count regression.
8. Rebuilds the chain bottom-up: replaces the `JoinNode` with the preserved side, then re-wraps with the same `Filter`/`Sort`/`LimitOffset`/`Distinct`/`Alias` instances. The preserved `ProjectNode` is rebuilt with `preserveAttributeIds` so callers' bindings survive untouched.

### Key files

- `packages/quereus/src/planner/rules/join/rule-join-elimination.ts` — new rule.
- `packages/quereus/src/planner/optimizer.ts` — import + structural-pass registration at priority 24.
- `packages/quereus/test/optimizer/rule-join-elimination.spec.ts` — 9 specs (LEFT eliminate, LEFT projection-uses-right negative, residual-filter-above-join negative, INNER NOT NULL eliminate, INNER nullable negative, missing-FK negative, CROSS/SEMI/ANTI negatives, view-elimination smoke, result equality across all eliminable shapes).
- `packages/quereus/test/logic/11-joins.sqllogic` — appended regression block.
- `docs/optimizer.md` § Optimization Rules → Join — rule entry added.
- `docs/architecture.md` § Key Design Decisions — federation bullet cross-links the rule.

## Testing notes

All passes locally:

- `yarn workspace @quereus/quereus run lint` → 0 issues.
- `yarn workspace @quereus/quereus run test` → 2836 passing, 0 failing.
- The new spec file: 9 passing.

## Manual smoke queries (for reviewer verification)

```sql
CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, region TEXT) USING memory;
CREATE TABLE orders (
  order_id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  total REAL
) USING memory;
INSERT INTO customers VALUES (1, 'Acme', 'EU'), (2, 'Beta', 'US');
INSERT INTO orders VALUES (10, 1, 99.0), (11, 2, 49.5), (12, 1, 12.0);

-- Eliminable (LEFT); query_plan should show NO join op
SELECT order_id, total FROM orders LEFT JOIN customers ON orders.customer_id = customers.id;

-- Eliminable (INNER, NOT NULL FK); query_plan should show NO join op
SELECT order_id FROM orders JOIN customers ON orders.customer_id = customers.id;

-- NOT eliminable (right column referenced)
SELECT order_id, customers.name FROM orders LEFT JOIN customers ON orders.customer_id = customers.id;
```

`SELECT * FROM query_plan(?)` should show **no** rows where `op IN ('JOIN','HASHJOIN','MERGEJOIN','NESTEDLOOPJOIN','BLOOMJOIN','ASOFSCAN')` for the first two; the third should still contain a join op.

## Areas worth reviewer attention

- **Pass-through whitelist completeness.** The walk goes through `Filter`, `Sort`, `LimitOffset`, `Distinct`, `Alias`. Anything else (Aggregate, Window, CTE, Set) bails. Reviewer should sanity-check that none of the bail-out nodes can legitimately be added without correctness work.
- **Non-equi residual rejection.** `isAndOfColumnEqualities` walks the normalized predicate and rejects anything other than `colRef = colRef` conjuncts. The ON-clause `extractEquiPairsFromCondition` already gives us the pairs, but a predicate like `A.x = B.x AND A.amount > 10` would pass `extractEquiPairsFromCondition` and silently change cardinality if we didn't reject the residual.
- **Right-join symmetry.** `tryEliminate(_, 'left', _)` was tested implicitly via INNER; pure RIGHT-JOIN tests aren't in the spec because the `11-joins.sqllogic` baseline marks RIGHT JOIN as "not supported yet" today. If/when RIGHT JOIN comes online the rule should fire on it — worth confirming the algorithm's RIGHT branch is correct on paper.
- **FK enforcement flag.** `ForeignKeyConstraintSchema` (`packages/quereus/src/schema/table.ts:356`) has no "enforced/unenforced" bit today; the ticket says "treat declared FK as enforced". If an `unenforced` flag is added later, the rule will need to consult it.
- **Doc cross-references.** The architecture-md federation bullet links into optimizer-md's rule catalog; double-check the anchor target.

## Out-of-scope deferrals (discovered during implementation)

- Eliminating joins under an `AggregateNode` that GROUP BYs the FK directly while no right cols are referenced — still needs Aggregate-aware demanded-set walking.
- Cascading elimination across multiple stacked joins — relies on the structural pass re-iterating; single-pass single-elimination is the v1 contract.
- Eliminating below other boundaries (Window, Aggregate, CTE references) — only `ProjectNode`-rooted chains are in scope.
- Removing pushed-down `RetrieveNode` predicates on the eliminated side — they disappear with the side as collateral.
