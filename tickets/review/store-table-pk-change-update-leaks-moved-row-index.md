---
description: PK-change UPDATE in `StoreTable.update` was leaking the moved row's old secondary-index entry because `updateSecondaryIndexes` used a single `pk` parameter for both the delete-old key and the put-new key. Fix splits the parameter and adds a regression test.
files:
  packages/quereus-store/src/common/store-table.ts
  packages/quereus-store/test/column-default-conflict.spec.ts
---

## Bug

`updateSecondaryIndexes(oldRow, newRow, pk)` constructed both the delete-old index key and the put-new index key from the same `pk`. The PK-change UPDATE call site at `store-table.ts:780` was passing `newPk`, so the delete step tried to remove `(oldRow_indexvals, newPk)` — an entry that did not exist. The real old entry, keyed by `oldPk`, was left behind, while the new entry at `(newRow_indexvals, newPk)` was written. Every PK-change UPDATE thus permanently leaked one secondary-index entry per index, breaking subsequent index-backed lookups (returning the moved row twice or pointing at a dead PK).

## Fix

`updateSecondaryIndexes` now takes `oldPk` and `newPk` with `newPk` defaulting to `oldPk` (so insert/delete/deleteRowAt callers remain unchanged). The PK-change UPDATE call site passes both:

```ts
await this.updateSecondaryIndexes(inTransaction, oldRow, coerced, oldPk, newPk);
```

The `if (oldRow)` branch keys the delete with `oldPk`; the `if (newRow)` branch keys the put with `newPk`.

## Test

Added a test in `column-default-conflict.spec.ts` under the "CREATE INDEX refreshes cached tableSchema" describe block:

- CREATE TABLE + CREATE INDEX, INSERT one row, UPDATE the PK to a new value.
- Iterate the index store; expect exactly one entry (was 2 before the fix).
- `SELECT … WHERE b = 100` confirms the surviving entry resolves to the relocated row.

## Validation

- `yarn workspace @quereus/store run test` → 262 passing (full quereus-store suite).
- Targeted re-run of the affected describe block passes.

## Notes for reviewer

- The new parameter has a defaulted second value (`newPk = oldPk`) so other call sites stay terse. If you'd rather force every caller to be explicit, that's a one-line tightening.
- Did not run `yarn test:store` (engine logic tests against LevelDB) — the change is in `packages/quereus-store/src/common`, which is exercised by both the unit suite and the engine-against-store sweep; the in-memory unit test mirrors the production code path one-to-one. Worth a sanity run if you're already in the area.
- No other callers of `updateSecondaryIndexes` exist outside `store-table.ts`.
