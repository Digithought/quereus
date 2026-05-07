description: Composite (ASC, DESC) index now consumed for `equality on leading + ORDER BY DESC on trailing`; equality-bound prefix columns are skipped when matching index ordering. Plus a follow-on fix preventing OR_RANGE plans from falsely claiming ordering.
files:
  packages/quereus/src/vtab/memory/module.ts (adjustPlanForOrdering, indexSatisfiesOrdering, collectEqualityBoundColumns)
  packages/quereus/test/optimizer/desc-index-ordering.spec.ts
  packages/quereus/test/optimizer/extended-constraint-pushdown.spec.ts (regression coverage in `handles OR with range predicate as residual correctly`)
----

## What was built

Two related changes in `packages/quereus/src/vtab/memory/module.ts`:

1. **Equality-prefix skip in `indexSatisfiesOrdering`** (already landed in commit `8c9e5686 ticket(review): allow-aggregates-in-order-by`).
   - New helper `collectEqualityBoundColumns` builds the set of column indexes bound by `=` or single-value `IN`.
   - `indexSatisfiesOrdering` skips leading index columns in that set before aligning the remaining index columns against the required ordering keys (still per-column direction comparison on the unbound suffix). Equality-bound columns interleaved after the matched prefix are also tolerated.
   - Companion guard in `adjustPlanForOrdering`: if the plan already binds a specific index for filtering/seeking, only that same index can claim to provide ordering (a full-scan plan is free to be converted into an ordering-providing IndexScan over any candidate).

2. **OR_RANGE ordering guard in `adjustPlanForOrdering`** (this ticket's incremental fix on top of the above).
   - A multi-range (`OR_RANGE`) access scans ranges independently and concatenates their outputs, so total ordering across ranges is not preserved — even when the underlying index is monotonic on the required column.
   - When any handled filter is `OR_RANGE`, `adjustPlanForOrdering` short-circuits and returns the plan unchanged (no `providesOrdering`). The planner then inserts an explicit `SORT` node when ORDER BY is present.
   - Without this guard, the prefix-skip change incorrectly let `_primary_` (id ASC) advertise ordering for a query like `SELECT id FROM items WHERE id > 3 OR id < 2 ORDER BY id`, producing `[4, 5, 1]` instead of `[1, 4, 5]`.

## Use cases & validation

Forward — the targeted scenarios:

- **Composite (ASC, DESC) index satisfies equality + DESC**:
  `CREATE INDEX ix_m ON m(category ASC, score DESC)`
  + `WHERE category = 'a' ORDER BY score DESC`
  → no `SORT` node; rows already in `[30, 20, 10]`.
- **DESC index for ORDER BY DESC** (existing): `CREATE INDEX ix ON t(score DESC)` + `ORDER BY score DESC` → no SORT.
- **DESC index for range + ORDER BY DESC** (existing): `WHERE n >= 60 ORDER BY n DESC` → IndexSeek on DESC index.

Regression — covered by `Extended constraint pushdown > OR predicates > handles OR with range predicate as residual correctly`:

- `SELECT id FROM items WHERE id > 3 OR id < 2 ORDER BY id` → returns `[1, 4, 5]` in id-sorted order. The plan now retains a `SORT` over the OR_RANGE access (rather than falsely claiming ordering from `_primary_`).

## Tests

- `packages/quereus/test/optimizer/desc-index-ordering.spec.ts` — all 3 tests pass (the previously skipped composite test is now active).
- `packages/quereus/test/optimizer/extended-constraint-pushdown.spec.ts` — `OR predicates > handles OR with range predicate as residual correctly` passes.
- Full quereus suite: 993 passing, 1 failing (`Predicate normalizer > double negation: NOT NOT (a > 10) equals a > 10`). That failure is **pre-existing and unrelated to this ticket** — it reproduces with both the pre-fix and post-fix code on `module.ts` (verified by stashing and re-running). Investigation belongs in a separate fix ticket.
- `yarn lint` for `packages/quereus` clean (exit 0).

## Review focus

- Confirm the `usesOrRange` guard placement in `adjustPlanForOrdering` is the right layer. Alternative: have `evaluateIndexAccess` mark the plan with a "non-monotonic" flag for OR_RANGE, but that surfaces a memory-module-internal concern in the shared `BestAccessPlanResult` shape.
- Sanity-check that no other access paths emit non-monotonic row order without a corresponding signal (composite multi-seek? trailing-range? — they're internally monotonic on the seek prefix and the trailing range).
- The pre-existing `double negation` failure should get its own fix ticket if it isn't already tracked.
