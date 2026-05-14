---
description: Optimizer rule that eliminates joins whose non-preserved side is never consumed above the join and is at-most-one-matching per FK→PK alignment.
prereq: fd-property-foundation, fd-from-equivalence-classes, fd-outer-join-key-preservation
files:
  - packages/quereus/src/planner/rules/join/rule-join-elimination.ts (new)
  - packages/quereus/src/planner/optimizer.ts
  - packages/quereus/src/planner/nodes/join-node.ts (read-only — extractEquiPairsFromCondition)
  - packages/quereus/src/planner/util/key-utils.ts (read-only — checkFkPkAlignment, extractTableSchema)
  - packages/quereus/src/planner/nodes/project-node.ts (read-only)
  - packages/quereus/src/planner/nodes/filter.ts (read-only)
  - packages/quereus/src/planner/nodes/sort.ts (read-only)
  - packages/quereus/src/planner/nodes/limit-offset.ts (read-only)
  - packages/quereus/test/optimizer/rule-join-elimination.spec.ts (new)
  - packages/quereus/test/logic/05-joins.sqllogic
  - docs/optimizer.md
  - docs/architecture.md
---

## Goal

Eliminate joins of the shape `A LEFT JOIN B ON A.fk = B.pk` (and the matching INNER JOIN variant under a NOT-NULL, enforced FK) when no caller above the join references any `B` column. Most common shape: views that join a parent table for FK-driven columns the outer caller never selects.

## Architectural choice — where the rule fires

The ticket text says "Operates on `JoinNode`," but the rule's premise — "no column from the eliminable side is referenced above the join" — needs ancestor knowledge that `JoinNode` rules don't get. `OptContext` has no parent stack, and the rule signature is `(node, ctx) → node | null`.

Resolution: **register the rule on `ProjectNode`** (the practical "consumer" boundary), and walk *down* from there through pass-through nodes (`Filter`, `Sort`, `LimitOffset`, `Distinct`, `Alias`) collecting demanded attribute IDs en route. When the walk reaches a `JoinNode`, the demanded-attr set is complete *for that chain*. If the demanded set intersects exactly one of the join's sides, that side is preserved and the other is a candidate for elimination. The rule then validates FK→PK alignment and rebuilds the chain with the join replaced by the preserved side.

This mirrors `ruleProjectionPruning`'s established pattern (fire on the boundary, look down). `ProjectNode` is the canonical SELECT-list boundary; any deeper join sitting under a Project that uses only one side is the exact view-elimination case the ticket targets.

Joins whose only consumer is *another* join (e.g. a chain of joins where an upstream join references both sides) are out of scope here — those don't satisfy the "no column from eliminable side referenced above" predicate at the inner-join level.

## Algorithm

1. Entry: `node` is a `ProjectNode`. Walk down `node.source` through a whitelist of pass-through nodes:
   - `FilterNode` — collect attr IDs from `predicate`.
   - `SortNode` — collect attr IDs from each sort key.
   - `LimitOffsetNode` — no attrs.
   - `DistinctNode` — no attrs.
   - `AliasNode` — no attrs (passes through).
   - `JoinNode` — terminate; this is the candidate.
   - Anything else — bail (return `null`).

   Seed the demanded set from `node.projections[*].node` expression trees.

2. Required join shape:
   - `joinType` ∈ {`left`, `right`, `inner`}.
   - `condition` exists and `extractEquiPairsFromCondition` returns ≥1 pair.
   - The condition has *no* non-equi residual conjuncts beyond the equi-pairs. If `normalizePredicate` yields AND-of-equalities only, fine; otherwise bail. (A non-equi residual references some side beyond the FK columns and would change cardinality.)

3. Classify demanded attr IDs against `join.left.getAttributes()` and `join.right.getAttributes()`:
   - `usesLeft` = demanded ∩ leftAttrIds ≠ ∅
   - `usesRight` = demanded ∩ rightAttrIds ≠ ∅

   For elimination, exactly one side must be used. (If both used → no elimination. If neither used → degenerate; pick by `joinType`'s preserved side.)

4. Pick `(eliminableSide, preservedSide)`:
   - `left` join: only the right side can be eliminated (the left is the preserved side by definition). Require `!usesRight`.
   - `right` join: only the left can be eliminated. Require `!usesLeft`.
   - `inner` join: either side. If `!usesRight` → try eliminating right; else if `!usesLeft` → try eliminating left.

5. Cardinality preservation. Extract `TableSchema` for each side via `extractTableSchema` (`key-utils.ts:326`). Compute `fkEquiIndices` and `pkEquiIndices` from the equi-pairs (translating to column indices on the FK and PK sides respectively):
   - `LEFT` eliminating right: `checkFkPkAlignment(leftSchema, rightSchema, leftEquiCols, rightEquiCols)`. PK side is right.
   - `RIGHT` eliminating left: symmetric (`checkFkPkAlignment(rightSchema, leftSchema, rightEquiCols, leftEquiCols)`).
   - `INNER`: same as the corresponding outer variant, **plus** the additional NOT-NULL + enforced-FK guarantee on the FK side:
     - For every FK column in the matching foreign key: `fkSchema.columns[fkColIdx].notNull === true`.
     - The FK is enforced (no `OR IGNORE` / unenforced flag — read whatever bit `TableSchema.foreignKeys[i]` exposes; if no enforcement flag exists today, treat any declared FK as enforced).

   If alignment fails or the INNER-JOIN safety guard fails, return `null`.

6. Rewrite. Replace the `JoinNode` in the chain with `preservedSide` (preserving attribute IDs is automatic — `buildJoinAttributes` reuses left/right attr IDs verbatim, only flipping nullability for null-padded outer sides; the preserved side never gets its nullability flipped). Rebuild the chain from bottom up using each pass-through node's constructor (`new FilterNode(scope, newSource, predicate)`, `new SortNode(scope, newSource, sortKeys)`, etc.).

7. Return the rebuilt `ProjectNode`.

## Files in detail

### `packages/quereus/src/planner/rules/join/rule-join-elimination.ts` (new)

```ts
export function ruleJoinElimination(node: PlanNode, _ctx: OptContext): PlanNode | null {
  if (!(node instanceof ProjectNode)) return null;
  // 1. collect demanded IDs from node.projections
  // 2. walk down through pass-through chain → join
  // 3. shape/safety checks
  // 4. classify + pick side
  // 5. FK/PK alignment via checkFkPkAlignment
  // 6. rebuild chain
}
```

Helpers (kept local until reused):

- `collectAttrIds(scalar: ScalarPlanNode, out: Set<number>)` — copy the walk from `rule-predicate-pushdown.ts:133`.
- `walkChain(root: RelationalPlanNode, demanded: Set<number>): { join: JoinNode; chain: Array<{ kind, node }> } | null`.
- `rebuildChain(chain, newBottom): RelationalPlanNode`.
- `findFkRelationship(fkSchema, pkSchema, equiPairs)`: returns the matching FK row + whether the FK columns are all `NOT NULL` (for INNER safety).

`checkFkPkAlignment` in `key-utils.ts:357` already validates equi-pair alignment with FK→PK; the rule consumes it directly.

### `packages/quereus/src/planner/optimizer.ts`

Add an import, then register at priority **24** in the **Structural** pass on `PlanNodeType.Project`. Order rationale (already documented in the ticket):

- 19 `projection-pruning` (Project on Project — runs first so we operate on a pruned shape)
- 19 `aggregate-predicate-pushdown` (Filter)
- 20 `predicate-pushdown` (Filter — must run before elimination so right-side filters land below the join)
- 21 `filter-merge` (Filter)
- 22 `scalar-cse` (Project)
- 23 `groupby-fd-simplification` (Aggregate)
- **24 `join-elimination` (Project)** ← new
- 25 `subquery-decorrelation` (Filter)

### Tests — `packages/quereus/test/optimizer/rule-join-elimination.spec.ts` (new)

Setup:

```sql
CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, region TEXT) USING memory;
CREATE TABLE orders (
  order_id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  total REAL
) USING memory;
INSERT INTO customers VALUES (1, 'Acme', 'EU'), (2, 'Beta', 'US');
INSERT INTO orders VALUES (10, 1, 99.0), (11, 2, 49.5), (12, 1, 12.0);
```

Spec coverage:

- **Eliminates LEFT JOIN when no right cols selected.**
  `SELECT order_id, total FROM orders LEFT JOIN customers ON orders.customer_id = customers.id`.
  Assert: `query_plan` reports zero `JOIN`/`HASHJOIN`/`NESTEDLOOP`/`MERGEJOIN`/`BLOOMJOIN` rows; result rows match the un-rewritten query (3 rows with order_id and total).

- **Does NOT eliminate when right column is in projection.**
  Same join, `SELECT order_id, customers.name FROM ...` → at least one join node remains.

- **Does NOT eliminate when right column is in WHERE *above* the join.**
  Add an explicit Filter above by a query shape that defeats predicate pushdown, e.g. wrap in a CTE and select with a residual: `SELECT order_id FROM (orders LEFT JOIN customers ON …) WHERE customers.region IS NOT NULL`. The Filter on `region` must remain above the join (verify via plan). Then assert the join is NOT eliminated.

- **Eliminates INNER JOIN when FK is NOT NULL.**
  `SELECT order_id FROM orders INNER JOIN customers ON orders.customer_id = customers.id` → no join in plan; rows match.

- **Does NOT eliminate INNER JOIN when FK column is nullable.**
  Define a second pair `orders_nullable(customer_id INTEGER REFERENCES customers(id))` (no NOT NULL). Same shape, no elimination.

- **Does NOT eliminate when no FK declared.**
  A `parents` and `children` pair where the FK is omitted; equi-join on PK-side unique but FK→PK relationship is absent → no elimination (preserves SQL semantics around missing parents on LEFT JOIN, and cardinality is not provably preserved on INNER).

- **Does NOT eliminate FULL OUTER / CROSS / SEMI / ANTI.**

- **Result-row equality across all eliminable cases.** Run the query before *and* after (toggle the rule off via `tuning.disabledRules` if available, otherwise compare via `query_plan` text + result tuples).

Use the chai/mocha pattern from `test/optimizer/filter-merge.spec.ts` for plan-shape assertions via `query_plan(?)`.

### Logic test — `packages/quereus/test/logic/05-joins.sqllogic`

Append a `# Join elimination — FK→PK` section with a few queries that verify identical result rows after the rule fires. Logic tests do not assert plan shape — they're a regression safety net for the rewrite's correctness.

### Documentation

- `docs/optimizer.md` — add a rule entry under "Optimization Rules → Join" describing the rule, its prerequisites (FK/PK schema, NOT NULL on FK for INNER), and how it interacts with FK→PK row-count reasoning. Cross-link to the FK→PK FD discussion already in place from `fd-from-equivalence-classes`.
- `docs/architecture.md` — extend the federation paragraph in "Key Design Decisions" to note that FK-driven join elimination materially reduces remote-table joins; one-sentence cross-reference to `docs/optimizer.md`.

## Use cases / validation queries

```sql
-- Eliminable (LEFT)
SELECT order_id, total FROM orders LEFT JOIN customers ON orders.customer_id = customers.id;
-- Eliminable (INNER, NOT NULL FK)
SELECT order_id FROM orders JOIN customers ON orders.customer_id = customers.id;
-- Not eliminable (right cols used)
SELECT order_id, customers.name FROM orders LEFT JOIN customers ON orders.customer_id = customers.id;
-- View-elimination smoke
CREATE VIEW order_view AS
  SELECT o.order_id, o.total, c.name AS cust_name
  FROM orders o LEFT JOIN customers c ON o.customer_id = c.id;
SELECT order_id, total FROM order_view;  -- the c join disappears
```

## Out of scope

- Eliminating joins under an Aggregate that GROUP BYs the FK directly while no right cols are referenced — needs Aggregate-aware demanded-set walking; defer.
- Cascading elimination across multiple stacked joins where elimination of one frees demand on another — the structural pass re-iterates, so single-rule elimination one at a time is fine.
- Eliminating below other boundaries (Window, Aggregate, CTE references) — only `ProjectNode`-rooted chains in this pass.
- Removing pushed-down `RetrieveNode` predicates on the eliminated side — they're collateral and disappear with the side.

## TODO

Phase 1 — rule core

- Create `packages/quereus/src/planner/rules/join/rule-join-elimination.ts` with `ruleJoinElimination`, `collectAttrIds`, `walkChain`, `rebuildChain`, FK/PK validation helpers.
- Wire INNER-JOIN safety via the `notNull` flag on each FK column and the FK's enforcement flag (check `TableSchema.foreignKeys` shape — if no enforcement bit today, treat declared FK as enforced).
- Reject non-equi residual conjuncts in the join condition.

Phase 2 — registration

- Import and register `ruleJoinElimination` in `packages/quereus/src/planner/optimizer.ts` at priority 24, Structural pass, `PlanNodeType.Project`.

Phase 3 — tests

- Add `packages/quereus/test/optimizer/rule-join-elimination.spec.ts` with the 8 specs listed above (LEFT eliminate, LEFT projection-uses-right negative, WHERE-above-join negative, INNER NOT NULL eliminate, INNER nullable negative, missing-FK negative, FULL/CROSS/SEMI/ANTI negative, result equality).
- Append a `# Join elimination` block to `packages/quereus/test/logic/05-joins.sqllogic` with result-row regression queries.

Phase 4 — validation

- `yarn workspace @quereus/quereus run lint 2>&1 | tee /tmp/lint.log` — 0 issues.
- `yarn workspace @quereus/quereus run test 2>&1 | tee /tmp/test.log` — full quereus suite passes (no regressions in keys-propagation, fd-propagation, join-quickpick, monotonic-merge-join, predicate-pushdown specs).

Phase 5 — docs

- Update `docs/optimizer.md` rule catalog (Join section).
- Add cross-reference paragraph in `docs/architecture.md` federation discussion.

Phase 6 — review handoff

- Distill into a review-stage ticket at `tickets/review/3-rule-join-elimination-fk-pk.md` with: what was built, key files, testing notes, manual smoke queries, and any out-of-scope deferrals discovered during implementation.
- Delete this implement-stage file.
