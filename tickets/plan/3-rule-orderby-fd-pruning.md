---
description: Optimizer rule that drops trailing ORDER BY keys that are functionally determined by leading keys
prereq: fd-property-foundation, fd-from-injective-projections, fd-from-equivalence-classes
files:
  - packages/quereus/src/planner/rules/sort/rule-orderby-fd-pruning.ts (new)
  - packages/quereus/src/planner/framework/registry.ts
  - packages/quereus/src/planner/nodes/sort.ts
  - packages/quereus/test/optimizer/rule-orderby-fd-pruning.spec.ts
  - packages/quereus/test/logic/04-order-by.sqllogic
  - docs/optimizer.md
---

## Motivation

When ORDER BY keys include a column that is functionally determined by an earlier ORDER BY column, the trailing key is redundant — it can never change the sort order, because any pair of rows that ties on the leading keys also ties on the determined keys. A multi-key sort is strictly more expensive than a single-key sort (longer comparators, larger comparison work per pair), so dropping redundant trailing keys directly reduces runtime cost.

```sql
-- customer_id determines customer_name (FK to a customers PK)
SELECT * FROM orders_with_customer ORDER BY customer_id, customer_name;
-- After rule: ORDER BY customer_id

-- After FD-from-EC: a = b means b is determined by a (and vice versa)
SELECT * FROM t WHERE a = b ORDER BY a, b;
-- After rule: ORDER BY a
```

Combined with `rule-groupby-fd-simplification`, this rule cleans up the common OLAP shape where ordering and grouping carry the same redundant FK-derived columns.

## Architecture

### Rule placement

`ruleOrderByFdPruning` in `planner/rules/sort/` (new category — or place under `predicate/` or in a general `rules/sort/` if one exists). Registered in the Structural pass or early Physical pass, after the FD-deriving rules have run on the source.

The rule applies to `SortNode`. ORDER BY clauses on aggregate/window/limit-offset nodes are typically lowered to `SortNode` wrapping the inner node; this rule fires regardless of context.

### Algorithm

For a `SortNode` with sort keys `K = [k0, k1, …, kN]` (each key is `{ column, desc }`):

1. Skip if `|K| ≤ 1` — no pruning possible.
2. Walk `K` from front to back, maintaining `determined = closure({column of k0, k1, …, ki-1}, source.fds, source.equivClasses)`.
3. For each `ki`, if `ki.column ∈ determined`, mark it for removal.
4. Skip keys whose underlying expression is non-trivial (not a direct `ColumnReferenceNode`). FDs are stated over column attributes, not arbitrary expressions; expressions need injective-derivation work that's already covered by `fd-from-injective-projections`. The pruning rule consumes the resulting `fds`, so injective-derived columns work out-of-the-box.
5. If any keys were removed, rebuild the `SortNode` with the surviving keys. If all but one key was removed, the surviving sort is still useful (don't eliminate the `SortNode` entirely unless the source already provides the required ordering — that's a separate concern).

### NULL handling

SQL's `ORDER BY` treats all NULL values as equal for tie-breaking purposes (whether NULLS FIRST or NULLS LAST). An FD `a → b` says that rows agreeing on `a` agree on `b`, but in SQL `NULL = NULL` is `NULL`. Two rows both having `a = NULL` are not "the same" in WHERE semantics — but they ARE the same for ORDER BY tie-breaking, which uses `IS NOT DISTINCT FROM`. So FD-based pruning of trailing ORDER BY keys is safe even when the determinant column is nullable.

Edge case: if `a` is NOT NULL but the FD `a → b` only holds for non-null `a`, the rule is still safe. The case to watch is FDs derived from outer-join columns where null-padding might violate the FD on padded rows — covered by `fd-outer-join-key-preservation`'s correct propagation. As long as the FD set is accurate, the pruning rule is safe.

### Direction-of-sort consideration

If `a → b` and the sort is `ORDER BY a ASC, b DESC`, then `b` is still determined by `a`, so the direction of `b`'s sort is irrelevant — pruning is safe regardless of direction.

### Interaction with monotonic LIMIT/OFFSET pushdown

`monotonic-limit-pushdown` (`docs/optimizer.md` § "Monotonic LIMIT/OFFSET pushdown") fires when `ORDER BY` has a single key matching the leaf's `monotonicOn`. If pruning reduces a multi-key sort to a single key matching the leaf, the LIMIT/OFFSET pushdown rule becomes applicable where it wasn't before. Ordering: this rule must run before `monotonic-limit-pushdown` (which is at PostOptimization priority 8). If this rule lands in the Structural pass, that ordering is automatic.

## Use cases enabled

- Faster sorts on common FK-derived ORDER BY clauses.
- Single-key sorts become eligible for monotonic LIMIT/OFFSET pushdown after pruning.
- Cleaner plan shapes for visual inspection and golden-plan tests.

## Tests

- Unit test: `ORDER BY pk, name` where `name` is FD of `pk` reduces to `ORDER BY pk`.
- Unit test: `ORDER BY a, b WHERE a = b` reduces to `ORDER BY a`.
- Unit test: `ORDER BY a, b` without FD between them is left alone.
- Logic test: result rows are identical before and after the rule fires.
- Plan-shape test: after pruning, the `SortNode` has the expected reduced key list.
- Interaction test: pruning reduces a multi-key sort to a single key, and `monotonic-limit-pushdown` then converts the LIMIT/OFFSET into an ordinal seek.

## Documentation

- **docs/optimizer.md** — add a rule catalog entry. Reference it from the LIMIT/OFFSET pushdown section as an enabling rule.
- No `docs/architecture.md` change required.

## Out of scope

- Eliminating the `SortNode` entirely when source ordering already covers the (possibly pruned) sort keys — that's a separate "sort-elimination" rule (likely worth a follow-up ticket but not part of FD work specifically).
- ORDER BY with expressions — handled implicitly when those expressions resolve to FD-determined columns via `fd-from-injective-projections`.
