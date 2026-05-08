description: Memory module's `indexSatisfiesOrdering` claims an index satisfies `ORDER BY` on a column that is filtered by a multi-value `IN` list, but the runtime multi-seek visits IN values in IN-list order — not sorted order. Result: `ORDER BY` is silently dropped when the IN list is unsorted.
files:
  packages/quereus/src/vtab/memory/module.ts (collectEqualityBoundColumns, adjustPlanForOrdering, indexSatisfiesOrdering)
  packages/quereus/src/planner/rules/access/rule-select-access-path.ts (multi-seek emission, around lines 289-396)
  packages/quereus/test/optimizer/desc-index-ordering.spec.ts (good place to add coverage)
----

## Reproduction

```sql
CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER) USING memory;
INSERT INTO t VALUES (1, 10), (2, 20), (3, 30), (4, 40), (5, 50);
CREATE INDEX ix ON t(n);

-- Expected: [10, 30, 40]
-- Actual:   [40, 10, 30]   (visits IN list in declaration order, no SORT inserted)
SELECT n FROM t WHERE n IN (40, 10, 30) ORDER BY n;
```

`query_plan` for the failing query shows `INDEXSEEK` with no `SORT` node — the optimizer believes the multi-seek satisfies the ORDER BY. The IndexSeek emitter at `rule-select-access-path.ts:289-321` builds `seekKeys` directly from `inValues` (no sort), and the runtime walks them in that order.

## Root cause

`collectEqualityBoundColumns` in `packages/quereus/src/vtab/memory/module.ts:23-34` only adds **single-value** `IN` to the equality-bound set. Multi-value `IN` columns are therefore treated as *unbound* by `indexSatisfiesOrdering`, which then matches them against `requiredOrdering` via the per-column direction check and reports the index as ordering-providing.

But a multi-seek over IN values in IN-list order is **not** monotonic on the seek column unless the IN list is itself sorted. The current logic implicitly assumes monotonicity that the runtime does not provide.

## Options

1. **Treat multi-value `IN` as ordering-breaking on the seek column**: in `adjustPlanForOrdering`, short-circuit (return `plan` unchanged) whenever a handled filter is `IN` with `value.length > 1` AND the IN'd column appears in `requiredOrdering` — analogous to the existing `OR_RANGE` guard. Cheapest; falls back to an explicit `SORT`.
2. **Sort IN values at plan time** in `rule-select-access-path.ts` before building `seekKeys`. Preserves the no-SORT optimization, but requires a comparator consistent with the column's collation/type and only helps when the IN list is statically known (literals, not parameters/expressions).
3. **Sort multi-seek output at the emitter**: insert an in-pipeline merge or k-way step. Heaviest; equivalent to falling back to SORT in most cases.

Option 1 mirrors the OR_RANGE precedent and is the obvious starting point. Option 2 is a follow-on optimization once option 1 is in place.

## Use cases

- `WHERE n IN (40, 10, 30) ORDER BY n` → `[10, 30, 40]` (currently `[40, 10, 30]`).
- `WHERE n IN (10, 20, 30) ORDER BY n` (IN list already sorted) → `[10, 20, 30]` (works today by accident — should still work after fix).
- Composite `WHERE category = 'a' AND year IN (2025, 2024) ORDER BY year` — likely also affected (composite multi-seek cross-product walks unsorted).

## TODO

- Add a regression test under `packages/quereus/test/optimizer/desc-index-ordering.spec.ts` (or a sibling file) covering `IN (unsorted) + ORDER BY` on the IN'd column. Verify `query_plan` includes a `SORT` after the fix.
- Implement option 1 in `adjustPlanForOrdering` (mirror the `OR_RANGE` short-circuit, but conditioned on multi-value IN).
- Verify the existing `secondary-index-access.spec.ts > composite index IN multi-seek` cases still pass.
- Run full quereus suite; confirm no other tests rely on the buggy behavior.
