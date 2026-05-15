---
description: INSERT OR REPLACE on parent does not return replacedRow when the conflicting row lives only in the underlying store, so ON DELETE CASCADE does not fire
files:
  - packages/quereus-isolation/src/isolated-table.ts
  - packages/quereus-isolation/src/isolated-connection.ts
  - packages/quereus/src/runtime/emit/dml-executor.ts
  - packages/quereus/test/logic/41-foreign-keys.sqllogic
  - packages/quereus/test/logic.spec.ts
---

## Symptom

`41-foreign-keys.sqllogic` is in the `MEMORY_ONLY_FILES` skip list at `logic.spec.ts:43`
with the comment:

> INSERT OR REPLACE on parent when conflicting row is only in underlying store
> (not overlay) does not return replacedRow, so ON DELETE CASCADE does not fire.

In store mode, FK cascade semantics silently drop on the floor for any parent row whose
conflicting copy hasn't already been brought into the overlay. Children that should be
cascade-deleted remain, leaving orphan rows and a violated invariant.

## Expected behavior

`INSERT OR REPLACE` on a parent row must:
1. Detect the conflict against the merged view of (overlay ∪ underlying store), not just
   the overlay.
2. Surface the displaced row via the `replacedRow` field of the mutation result so the
   FK-cascade machinery in the DML executor can fire `ON DELETE CASCADE` on dependent rows.
3. Persist the new parent row through the overlay, with the displaced row tombstoned.

The memory-only path satisfies these because the conflict and the displaced row are both
in the same table; the overlay path needs to materialize the underlying-store row into the
overlay (or at least synthesize a `replacedRow` value) before the OR REPLACE conflict
resolution runs.

## Related work

- `3-isolation-fk-cascade-through-overlay.md` (complete) — fixed FK cascade through
  overlay in the general case but did not cover the OR-REPLACE-from-store path.
- `3-upsert-fk-cascade-missing.md` (complete) — covered upsert path; also did not cover
  this path.
- `2-wrong-change-type-on-insert-or-replace.md` (complete) — adjacent.

## Acceptance

- Reproduce the specific failure inside `41-foreign-keys.sqllogic` under
  `QUEREUS_TEST_STORE=1`; remove the file from `MEMORY_ONLY_FILES` once fixed.
- Add a focused store-mode regression that exercises: parent row in underlying store,
  child row in either overlay or store, INSERT OR REPLACE on parent, verify children are
  cascade-deleted.
- Cover ON DELETE SET NULL and SET DEFAULT variants too if they share the same path.
- `yarn test` and `yarn test:store` both green.
