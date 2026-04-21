description: Fix store-module predicate pushdown so range filters on non-leading PK columns are no longer silently dropped (especially on tables with no explicit PRIMARY KEY).
dependencies: none
files:
  packages/quereus-store/src/common/store-module.ts (modified — getBestAccessPlan range branch)
  packages/quereus-store/test/pushdown.spec.ts (new spec)
  packages/quereus/test/logic/pushdown-test.sqllogic (now passes under store mode)
----

## What changed

`StoreModule.getBestAccessPlan` previously claimed `handled=true` for any range filter on any PK column, but the legacy access-path planner (`rule-select-access-path.ts:698–738`) only forwards range bounds for `primaryKeyDefinition[0]`. Ranges on non-leading PK columns were lost — and on a table without an explicit PRIMARY KEY (where every column becomes part of the implicit PK), this meant that a `WHERE age > 25` returned every row.

Fix narrows the range branch to filters whose `columnIndex === primaryKeyDefinition[0].index`. Anything else falls through to the secondary-index check or the full-scan path with `handledFilters` all `false`, so the residual predicate stays above the scan and is applied by the engine.

The fix mirrors the precedent already in the same method's secondary-index branch, which deliberately reports `handled=false` because the runtime can't apply index-backed bounds yet.

## Validation

- `packages/quereus-store/test/pushdown.spec.ts` — new spec covering four cases through `db.exec`/`db.eval`:
  - explicit `PRIMARY KEY (id)` + range on `id` (range-scan path)
  - explicit `PRIMARY KEY (id)` + range on non-PK `age` (residual on full scan)
  - no explicit PK + range on first column (regression sanity)
  - no explicit PK + range on non-first column `age` (the bug)
  - no explicit PK + compound `age > 25 AND name LIKE 'A%'` (partial pushdown still works)
- `packages/quereus/test/logic/pushdown-test.sqllogic` — already existed; previously failed under `QUEREUS_TEST_STORE=true`, now passes (verified).
- `yarn workspace @quereus/store test` — 180 passing.
- `yarn test:store` — 502 passing. The single remaining failure is `03.6-type-system.sqllogic:235` (JSON value round-trip — `{"a":1}` returned as a string instead of an object), confirmed pre-existing by re-running with the fix reverted.

## Reviewer focus

- The `firstPkColumn` lookup returns `undefined` when `primaryKeyDefinition` is empty — the branch then short-circuits and the code falls through to the secondary-index / full-scan path, which is the correct conservative behavior. (For real Quereus tables this case shouldn't occur — `findPKDefinition` always populates a PK — but the guard keeps the planner honest.)
- The equality (full PK match) branch above is unchanged because it requires equality on **every** PK column, which the legacy planner does support via composite PK seeks.
- A range scan that's "handled" still falls back to `StoreTable.scanPKRange` which today does a full scan + `matchesFilters`. Real byte-range bounds remain a future optimization, called out in the original ticket but explicitly out of scope.
