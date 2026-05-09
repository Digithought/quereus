description: review competing-plan ordering selection in MemoryTableModule + providesOrdering invariant
prereq:
files: packages/quereus/src/vtab/memory/module.ts, packages/quereus/src/vtab/best-access-plan.ts, packages/quereus/test/optimizer/ordering-index-competition.spec.ts, packages/quereus/test/optimizer/desc-index-ordering.spec.ts, packages/quereus/test/vtab/best-access-plan.spec.ts
----

## Summary of changes

### `packages/quereus/src/vtab/memory/module.ts`
- Added two memory-table tuning knobs near the top of the file:
  - `SORT_COST_PER_COMPARISON = 0.1` — used to estimate avoided/incurred external sort.
  - `RESIDUAL_FILTER_COST_PER_ROW = 0.2` — per-row cost charged for each unhandled filter when an ordering-only plan leaves filters as residuals.
  - Helper `estimateSortCost(rows)` returning `0` when `rows ≤ 1` and `rows * log2(rows) * SORT_COST_PER_COMPARISON` otherwise.
- Replaced the arbitrary `cost * 0.9` "ordering discount" in `adjustPlanForOrdering` with a real **Plan A vs Plan B** competition:
  - **Plan A** keeps the chosen filter plan. If its `indexName` already satisfies the required ordering (and the access pattern is monotonic — no OR_RANGE, no multi-IN on an ordered column), claim ordering directly with cost unchanged. Otherwise charge `estimateSortCost(plan.rows)` and let the planner insert a `SortNode` above.
  - **Plan B** is computed by the new private method `evaluateOrderingOnlyPlans`: for each available index whose key suffix satisfies `requiredOrdering` (after stripping equality-bound columns), build either a useful seek/range plan from `evaluateIndexAccess` or a pure ordering scan via `AccessPlanBuilder.rangeScan`. Add residual-filter cost for unhandled filters and pick the cheapest.
  - Return whichever has the lower cost. Plan B always sets `indexName === orderingIndexName === <chosen index name>` so the new validator invariant holds.
- The signature of `adjustPlanForOrdering` now takes `estimatedTableSize` (used both for computing Plan A's notional sort cost and for the ordering-only scan cost in Plan B).

### `packages/quereus/src/vtab/best-access-plan.ts`
- Strengthened `validateAccessPlan`: whenever `providesOrdering` is non-empty, `orderingIndexName` is required, and if `indexName` is also set the two MUST refer to the same index. Throws `StatusCode.FORMAT` with a message naming both indexes when violated. The check protects all vtab modules — not just memory — and catches the original "claim ordering from a different index than the seek" correctness bug at the boundary.

### Tests
- New file `packages/quereus/test/optimizer/ordering-index-competition.spec.ts` covering:
  - Selective filter on secondary index + `ORDER BY` on PK column → results in PK order (whichever physical plan wins).
  - Same secondary index range + `ORDER BY` matching that index → no `SORT` in plan, results in range/order.
  - Tiny table with no index on the filter column → PK ordering scan + residual filter wins, no `SORT`.
  - `ORDER BY` matching secondary index, no filters → ordering-only `IndexScan` on that index, no `SORT`.
  - PK range + `ORDER BY` on PK → no `SORT`.
  - Cost-comparison crossover sweep (sizes 3 / 50 / 500): the chosen plan may differ but output is always correctly ordered.
- Updated `packages/quereus/test/vtab/best-access-plan.spec.ts`:
  - Existing `providesOrdering` tests now also set `orderingIndexName` (required by the new invariant).
  - Added regression tests: validator throws when `providesOrdering` lacks `orderingIndexName`, throws when `indexName !== orderingIndexName`, passes when they match.

## What to verify in review

- **Cost-tuning knobs.** `SORT_COST_PER_COMPARISON = 0.1` was chosen so a 1000-row sort is on the same order of magnitude as a 1000-row scan — a reasonable starting point given memory-table cost units. The full optimizer test suite still passes; if a previously-stable plan flips later, retune rather than chase the test. `RESIDUAL_FILTER_COST_PER_ROW = 0.2` mirrors the global `FILTER_PER_ROW`.
- **Invariant strength.** The validator now requires `orderingIndexName` whenever `providesOrdering` is non-empty. A few existing test fixtures had to be updated to pass — confirm no production code path emits a `providesOrdering` claim without `orderingIndexName`. (The PK post-pass at module.ts ~line 233 already sets it; same for `evaluateOrderingOnlyPlans`.)
- **Ordering-only routing.** Plan B sets `indexName + orderingIndexName + providesOrdering` and leaves `seekColumnIndexes` undefined, so it falls through `selectPhysicalNode`'s "index-aware" guard (which requires non-empty `seekColumnIndexes`) into the legacy fallback. The legacy fallback's ordering-only branch (`rule-select-access-path.ts:763–787`) reads `accessPlan.orderingIndexName ?? 'primary'` and routes to `IndexScanNode` correctly. No change to the rule was required.
- **Pre-existing limitation (out of scope).** `indexSatisfiesOrdering` strips equality-bound columns from the index but not from `requiredOrdering`. So `where x = c order by x` on an index whose only column is `x` reports false even though ordering is trivially satisfied. Not introduced by this ticket; calling out so reviewer doesn't waste time.

## Use cases

```sql
-- Selective filter on secondary index, ORDER BY on PK column.
-- Plan A (idx_status seek + sort) typically wins for selective filters.
CREATE TABLE t (id INTEGER PRIMARY KEY, status TEXT) USING memory;
CREATE INDEX ix_status ON t(status);
SELECT id FROM t WHERE status = 'active' ORDER BY id;

-- Tiny table or unselective filter, no useful index for the filter col.
-- Plan B (PK ordering scan + residual filter) wins.
SELECT id FROM t WHERE payload = 'aa' ORDER BY id;

-- Same-index seek + ORDER BY matches that index — no SORT inserted.
CREATE INDEX ix_score ON t(score);
SELECT id, score FROM t WHERE score >= 30 ORDER BY score;

-- Pure ordering, no filters — ordering-only IndexScan on the matching index.
SELECT * FROM t ORDER BY score;
```

## Validation status

- `yarn workspace @quereus/quereus run test` — 2703 passing, 2 pending, 0 failing.
- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn workspace @quereus/quereus run build` — clean.
- `yarn test:store` — not run (memory-only changes; TODO for reviewer if a release is upcoming).
