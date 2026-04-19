description: Store `getBestAccessPlan` marks range filters on non-leading PK columns as handled, but the legacy planner path only forwards ranges on the first PK column — causing predicate loss on tables where the range column isn't the first PK column (notably tables without an explicit PRIMARY KEY, where all columns become the PK).
dependencies: none
files:
  packages/quereus-store/src/common/store-module.ts
  packages/quereus/src/planner/rules/access/rule-select-access-path.ts (reference only — legacy range path at lines 698–738)
  packages/quereus-store/src/common/store-table.ts (reference only — `analyzePKAccess`/`scanPKRange`)
  packages/quereus/test/logic/pushdown-test.sqllogic (regression, already fails)
  packages/quereus-store/test/ (add new spec)
----

## Root cause

`StoreModule.getBestAccessPlan` (store-module.ts:662–681) accepts a range filter on **any** PK column and marks it as handled:

```ts
const rangeFilters = request.filters.filter(f =>
    f.columnIndex !== undefined &&
    pkColumns.includes(f.columnIndex) &&          // <-- any PK column
    rangeOps.includes(f.op)
);
```

However, the legacy physical-node selection at `rule-select-access-path.ts:698–738` only forwards range constraints that match `primaryFirstCol = tableSchema.primaryKeyDefinition[0].index`:

```ts
const lower = rangeCols.find(c => c.columnIndex === primaryFirstCol && ...);
const upper = rangeCols.find(c => c.columnIndex === primaryFirstCol && ...);
```

Ranges on non-leading PK columns get silently dropped — neither forwarded to `FilterInfo.constraints` (so `matchesFilters` has nothing to evaluate) nor applied as a residual above (because the plan claimed `handled=true`). Rows pass unfiltered.

A table with no explicit PRIMARY KEY makes **all** columns PK (see `findPKDefinition` in `packages/quereus/src/schema/table.ts:416`), so any range on any column but the first triggers this.

There's already a precedent for the fix in the same file (store-module.ts:683–688): the secondary-index branch explicitly does NOT mark filters handled because `query()` can't apply index-backed bounds yet.

## Fix

In `StoreModule.getBestAccessPlan`, only mark a range filter as handled when it's on the first PK column (the only case the legacy planner path actually forwards). If the range is on a non-leading PK column, fall through to the full-scan path with `handledFilters` all false — the residual predicate stays above the scan and is applied by the engine.

The cost estimate can still bias the plan toward "range scan" for first-PK-column ranges, which matches what `StoreTable.scanPKRange` / `analyzePKAccess` actually supports today (note: `scanPKRange` still does a full scan + `matchesFilters`; proper byte-range bounds remain a TODO but are out of scope here).

## Regression coverage

- `packages/quereus/test/logic/pushdown-test.sqllogic:13` already reproduces under `QUEREUS_TEST_STORE=true`; the fix makes it pass. Keep it untouched.
- Add a focused spec in `packages/quereus-store/test/pushdown.spec.ts` that exercises both PK and no-PK cases end-to-end via the memory-backed store provider (existing pattern in `packages/quereus-store/test/memory-store.spec.ts` / `isolated-store.spec.ts`). Cover:
  - Table with explicit `PRIMARY KEY (id)`, range on `id` → range-scan path, correct rows.
  - Table with explicit `PRIMARY KEY (id)`, range on non-PK column `age` → full-scan path, correct rows (residual applied above).
  - Table with **no** PRIMARY KEY, range on first column → correct rows.
  - Table with **no** PRIMARY KEY, range on non-first column → correct rows (this is the bug).
  - Compound predicate (range + LIKE) on no-PK table to make sure partial-pushdown still works.

## TODO

- Update `StoreModule.getBestAccessPlan` in `packages/quereus-store/src/common/store-module.ts` so only range filters on the first PK column are marked handled; ranges on non-leading PK columns fall through to the full-scan plan with `handledFilters: all false`.
- Add `packages/quereus-store/test/pushdown.spec.ts` covering the four cases above.
- Run `yarn workspace @quereus/quereus-store test` and `QUEREUS_TEST_STORE=true yarn workspace @quereus/quereus test --grep pushdown-test` — both must pass.
- Run full `yarn test:store` to verify no other logic tests regress.
