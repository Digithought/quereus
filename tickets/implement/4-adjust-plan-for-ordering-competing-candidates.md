description: replace arbitrary 10% ordering discount with competing-plan cost comparison; add providesOrdering invariant guard
files: packages/quereus/src/vtab/memory/module.ts, packages/quereus/src/vtab/best-access-plan.ts, packages/quereus/src/planner/rules/access/rule-select-access-path.ts, packages/quereus/test/optimizer/desc-index-ordering.spec.ts
----

## Context (calibrated against current code)

The original plan (`4-adjust-plan-for-ordering-unrelated-index.md`) called out two defects: (1) a correctness bug where `adjustPlanForOrdering` claimed ordering from an index unrelated to the chosen filter index, and (2) cost bias from a flat 10% discount.

Inspection of `packages/quereus/src/vtab/memory/module.ts` (lines 537–559) shows the **correctness scenario in the plan no longer reproduces**: when the chosen filter plan has `indexName` set, the candidate list for ordering is already restricted to that single index:

```ts
const candidates = plan.indexName
    ? availableIndexes.filter(idx => idx.name === plan.indexName)
    : availableIndexes;
```

So the worst case described in the plan ("`idx_status` seek with `orderingIndexName: '_primary_'` claim") cannot happen — when the filter index doesn't satisfy ordering, no ordering is claimed and a `SortNode` stays above the seek. The remaining live issues are the cost/efficiency ones:

1. **Arbitrary 10% discount.** When the filter index *does* satisfy ordering, `cost * 0.9` is applied unconditionally, regardless of how cheap or expensive the avoided sort would actually have been.
2. **No competing-plan evaluation.** When the filter index does *not* satisfy ordering, the planner emits filter-seek + sort. It never considers the alternative of scanning the ordering index and applying a residual filter — even when that would be far cheaper for low-selectivity filters or small tables.
3. **No invariant guard.** Nothing in `BestAccessPlanResult` enforces that `providesOrdering` may only be claimed when the iteration order actually matches. A future refactor or a third-party module could re-introduce the original correctness bug.

This ticket addresses all three.

## Design

### 1. Principled sort-cost comparison

Replace the flat `cost * 0.9` with a real estimate of the sort cost that would be saved:

```ts
function estimateSortCost(rows: number): number {
    if (rows <= 1) return 0;
    return rows * Math.log2(rows) * SORT_COST_PER_COMPARISON;
}
```

`SORT_COST_PER_COMPARISON` lives near the existing memory-table cost constants (it is a memory-table tuning knob, not a public contract). A starting value around `0.05`–`0.1` keeps current behavior roughly intact for small tables while scaling correctly with row count.

When the filter index satisfies ordering (same-index case): claim ordering, set cost to `plan.cost` (no discount needed — we're avoiding a sort that the planner will price separately on the alternative).

### 2. Competing ordering-only plans

Add a new private method `evaluateOrderingOnlyPlans(request, availableIndexes, equalityCols, estimatedTableSize)` that, for each index whose key suffix satisfies `requiredOrdering`:

- Builds an index-scan plan on that index (full scan in index order).
- Estimates residual filter cost: rows scanned × per-row residual-filter cost × number of unhandled filters. Filters that the ordering index *can* handle as equality on its leading columns are accounted for through the seek/range path of `evaluateIndexAccess`; filters it can't are pushed back as residual.
- The competing plan claims ordering (`providesOrdering = request.requiredOrdering`, `orderingIndexName = index.name`, `indexName = index.name`, `seekColumnIndexes` left undefined to indicate ordering-only). This routes through the existing ordering-only IndexScan path in `selectPhysicalNodeFromPlan` (rule-select-access-path.ts:628–653).
- Total cost: `indexScanCost + residualFilterCost` (no sort cost — ordering is provided).

Then in `getBestAccessPlan`'s ordering branch, compute:

- `costA` = best filtering plan cost + (`estimateSortCost(plan.rows)` if filter index doesn't satisfy ordering, else `0`)
- `costB` = cheapest ordering-only competing plan cost
- Return the cheaper. When `costA` wins and the filter index satisfies ordering, claim it directly; when `costA` wins and the filter index doesn't, return the filter plan unchanged (sort lands above).

### 3. Invariant: `providesOrdering` ⇒ ordering claim must be safe

Strengthen `validateAccessPlan` in `packages/quereus/src/vtab/best-access-plan.ts`:

```
if (result.providesOrdering && result.providesOrdering.length > 0) {
    if (!result.orderingIndexName) {
        quereusError('providesOrdering requires orderingIndexName', StatusCode.FORMAT);
    }
    // Either ordering comes from the same index used for seeking (safe),
    // or the plan is an ordering-only scan with no seek constraints.
    if (result.indexName && result.indexName !== result.orderingIndexName) {
        quereusError(
            `providesOrdering claims ordering from '${result.orderingIndexName}' but plan seeks via '${result.indexName}'`,
            StatusCode.FORMAT
        );
    }
}
```

This is a defensive check that catches the original correctness bug at the boundary, regardless of which module emits the plan. It's cheap and runs only at plan time.

### 4. `selectPhysicalNodeFromPlan` re-routing

The existing rule (rule-select-access-path.ts:259–266) routes to the index-aware path when `accessPlan.indexName && seekColumnIndexes && seekColumnIndexes.length > 0`. The competing ordering-only plan deliberately leaves `seekColumnIndexes` undefined, so it falls through to the legacy path which already handles ordering-only IndexScanNode (lines 763–787).

Alternatively (cleaner): extend the index-aware path to detect `indexName && providesOrdering && (!seekColumnIndexes || seekColumnIndexes.length === 0)` and route directly to the ordering-only branch with the correct index name. This avoids the legacy fallback's PK-centric defaults. Pick whichever the implementer finds clearer when looking at the code in situ; both are correct.

## Tests

Add to `packages/quereus/test/optimizer/desc-index-ordering.spec.ts` (or a sibling file `ordering-index-competition.spec.ts` if the file is already long):

- **Secondary index seek + ORDER BY on PK columns**: e.g. table with PK `(id)` + secondary `(status)`, query `select * from t where status='active' order by id`. Assert results are correctly ordered by `id` (regardless of which physical plan wins). Use a row distribution that makes `status='active'` selective enough that filter-seek + sort is plausible, and a separate scenario where the table is small enough that a full PK scan + residual filter is plausible. **Both must produce correct ordering.**
- **PK seek + ORDER BY on PK columns**: sort eliminated, results in PK order (already covered by status quo, keep as regression).
- **No filters + ORDER BY matching secondary index**: ordering-only `IndexScanNode` on the secondary index, no SORT in the plan.
- **Secondary index seek + ORDER BY matching that same secondary index**: sort eliminated, no SORT in the plan.
- **Cost comparison crossover**: build a scenario where the secondary-index-seek+sort path *should* lose to the PK-scan path (e.g. selectivity ~50% and small N), and the inverse. Assert the chosen plan via `query_plan(?)` op count.
- **Validator regression**: a unit test that constructs a `BestAccessPlanResult` with mismatched `indexName`/`orderingIndexName` and asserts `validateAccessPlan` throws.
- **No-ORDER-BY queries unaffected**: regression check that adding the new branch doesn't perturb plans without ORDER BY (spot-check existing optimizer specs still pass).

## Notes / non-goals

- The `monotonicOn` advertisement (built by `buildMonotonicAdvertisement`) keys off `indexName ?? orderingIndexName`. With the new invariant they're equal whenever both are set, so this code stays correct without modification — but verify by re-running the bestaccessplan-monotonic-ordering specs.
- The PK-ordering post-pass at module.ts:207–223 (advertise PK order when no explicit ORDER BY) is independent and must continue to work.
- Don't touch other vtab modules; only `MemoryTableModule` implements `adjustPlanForOrdering` today. The `validateAccessPlan` strengthening protects all modules.
- Tune `SORT_COST_PER_COMPARISON` empirically against the existing optimizer specs — if a previously-stable plan flips, that's a signal the constant is mis-scaled, not necessarily that the test is wrong, but investigate before bumping.

## TODO

- Add `SORT_COST_PER_COMPARISON` (or equivalent) and `estimateSortCost` helper near the cost constants in `module.ts`.
- Implement `evaluateOrderingOnlyPlans` (private method on `MemoryTableModule`).
- Rewrite `adjustPlanForOrdering` to compute Plan A (filter + optional sort cost) vs Plan B (cheapest ordering-only) and return the winner.
- Drop the `cost * 0.9` discount.
- Strengthen `validateAccessPlan` with the `indexName === orderingIndexName` invariant. Make sure the error message names both indexes.
- Verify (or extend) `selectPhysicalNodeFromPlan` ordering-only branch handles `indexName + providesOrdering` with no seek columns cleanly. Adjust the routing condition if it currently requires `seekColumnIndexes`.
- Add the new tests listed above.
- Run `yarn workspace @quereus/quereus test` and `yarn workspace @quereus/quereus lint`. Re-run `bestaccessplan-monotonic-ordering`, `desc-index-ordering`, and `ordering-propagation` specs explicitly.
- Update `docs/optimizer.md` if it documents the 10% discount or describes ordering-claim selection rules. (Check first; don't add docs that didn't exist.)
