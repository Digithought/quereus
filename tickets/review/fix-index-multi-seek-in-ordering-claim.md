description: `adjustPlanForOrdering` short-circuits ORDER BY ordering claims when a multi-value `IN` filter targets an ordering column, mirroring the existing `OR_RANGE` guard. The multi-seek emitter visits IN values in IN-list (declaration) order, which is not monotonic on the seek column unless the IN list is itself sorted — so the index cannot satisfy ORDER BY without an explicit SORT.
files:
  packages/quereus/src/vtab/memory/module.ts
  packages/quereus/test/optimizer/desc-index-ordering.spec.ts
----

## What was built

`adjustPlanForOrdering` in `packages/quereus/src/vtab/memory/module.ts` previously consulted `indexSatisfiesOrdering` for any candidate index without considering that the runtime multi-seek (`rule-select-access-path.ts:289-396`) walks the IN list in declaration order. For a query like:

```sql
SELECT n FROM t WHERE n IN (40, 10, 30) ORDER BY n;
```

the planner believed the single-column index on `n` provided the ordering, omitted a SORT, and the engine returned `[40, 10, 30]` instead of `[10, 30, 40]`.

The fix adds a guard immediately after the existing `OR_RANGE` short-circuit: if any handled filter is a multi-value `IN` whose column appears in the required ordering, return the plan unchanged so the planner inserts an explicit SORT. This matches the precedent set by the OR_RANGE guard (multi-range concatenation also breaks total ordering) and uses the same shape — `request.filters.some((f, i) => plan.handledFilters[i] && ...)`.

`collectEqualityBoundColumns` (the helper that decides which leading index columns can be skipped when matching ordering) was deliberately left alone — it still treats only `=` and single-value `IN` as ordering-neutral. Multi-value IN remains *not* equality-bound, so the `indexSatisfiesOrdering` walk continues to fail at the IN'd column unless the new guard catches it first. The two layers are independent and complementary.

## Testing

- `packages/quereus/test/optimizer/desc-index-ordering.spec.ts` — added two regression cases:
  - `inserts SORT when ORDER BY targets a multi-value IN column (unsorted IN list)`: reproduces the ticket's exact failure (single-column index on `n`, `WHERE n IN (40,10,30) ORDER BY n`). Asserts the plan contains exactly one `SORT` node and the result rows come out as `[10, 30, 40]`.
  - `inserts SORT for composite multi-IN with ORDER BY on the IN column`: composite `(category, year)` index, `WHERE category='a' AND year IN (2025,2024,2026) ORDER BY year`. Asserts result row order is correct (`[2024, 2025, 2026]`). This case exercises the prefix-equality + multi-IN suffix path that the original ticket flagged in the "Use cases" section.
- All 5 tests in `desc-index-ordering.spec.ts` pass; the previously-passing 3 tests (DESC index single, DESC range, composite ASC/DESC) are unaffected.
- `packages/quereus/test/optimizer/secondary-index-access.spec.ts` — all 12 tests pass, including `composite index IN multi-seek` (4 cases). Those tests already used `ORDER BY title` on a non-indexed column, so they had explicit SORTs and are unaffected by the fix.
- Full quereus test suite: 995 passing. The one failure (`Predicate normalizer / double negation: NOT NOT (a > 10) equals a > 10`) is a pre-existing baseline failure on `main` (verified by `git stash`-ing the fix and re-running) and is unrelated to this ticket.
- Lint clean (`yarn workspace @quereus/quereus lint`, exit code 0).

## Usage

```sql
-- Before fix: returned [40, 10, 30] (IN-list order, no SORT inserted)
-- After fix:  returns  [10, 30, 40] (SORT enforces ORDER BY)
CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER) USING memory;
CREATE INDEX ix ON t(n);
INSERT INTO t VALUES (1, 10), (2, 20), (3, 30), (4, 40), (5, 50);
SELECT n FROM t WHERE n IN (40, 10, 30) ORDER BY n;

-- Composite case also fixed
CREATE TABLE e (id INTEGER PRIMARY KEY, category TEXT, year INTEGER) USING memory;
CREATE INDEX ix_e ON e(category, year);
SELECT year FROM e WHERE category='a' AND year IN (2025, 2024, 2026) ORDER BY year;

-- Already-sorted IN list still uses the index ordering (no SORT, by accident — same
-- output order as before; correctness preserved).
SELECT n FROM t WHERE n IN (10, 20, 30) ORDER BY n;
```

## Review focus

- The guard intentionally uses `request.requiredOrdering!` (non-null assertion) — `adjustPlanForOrdering` is only called when `request.requiredOrdering && request.requiredOrdering.length > 0` (see `findBestAccessPlan`, around line 199). Confirm no caller path bypasses that guard.
- The fix takes the conservative Option 1 from the ticket. The ticket also lists Option 2 (sort IN values at plan time when statically known) as a possible follow-on optimization to recover the no-SORT case for literal IN lists. Not implemented here — would be a separate enhancement.
- Composite case: when both `a` and `b` are multi-IN and `ORDER BY b`, the guard fires (because `b` is in the ordering and is a multi-IN handled filter). When `ORDER BY a`, the guard fires on `a`. When `ORDER BY c` (a third column on a composite index), the guard does *not* fire — but `indexSatisfiesOrdering` already fails in that case because `a` is not equality-bound, so no incorrect ordering claim is made. This was verified by tracing through the matching logic; no test was added for this specific case since it's a pre-existing safe path.
- The new guard is cheap (a single `Set` constructed once + an array `.some` over filters) and runs only when ORDER BY is present.
