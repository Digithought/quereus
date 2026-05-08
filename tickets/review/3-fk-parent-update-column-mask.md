description: Skip parent-side FK NOT-EXISTS check when no referenced column changed
prereq: none
files:
  packages/quereus/src/planner/building/foreign-key-builder.ts
  packages/quereus/src/planner/nodes/constraint-check-node.ts
  packages/quereus/src/runtime/emit/constraint-check.ts
  packages/quereus/test/logic/41-foreign-keys.sqllogic
----

## What changed

Post-`19e1963e`, FK ON UPDATE/ON DELETE defaults flipped to `'restrict'`, so every parent table now receives a synthesised NOT-EXISTS parent-side CHECK that previously was skipped. That check was firing on **every** parent UPDATE, breaking unrelated UPDATEs that don't touch any referenced parent column. The pre-existing comment at `foreign-key-builder.ts:291-292` flagged this gap as "fix later" — this ticket closed it.

### Code changes

1. `packages/quereus/src/planner/nodes/constraint-check-node.ts` — added optional `referencedColumnIndices?: ReadonlyArray<number>` to the `ConstraintCheck` interface, populated only for parent-side FK checks.
2. `packages/quereus/src/planner/building/foreign-key-builder.ts` — `buildParentSideFKChecks` now carries the resolved `parentColIndices` onto the synthesised constraint via that new field.
3. `packages/quereus/src/runtime/emit/constraint-check.ts` — propagated the field into `ConstraintMetadataEntry`. In `checkCheckConstraints`, before running the evaluator, when `plan.operation === RowOpFlag.UPDATE && metadata.kind === 'fk-parent' && metadata.referencedColumnIndices`, compare OLD vs NEW for each referenced column index using `sqlValuesEqual`; if none changed, `continue` past the check.

The OLD section of the flat row spans `0..n-1`, NEW spans `n..2n-1` (same shape consumed by the NOT NULL pass and `runUpdate`'s `changedColumns` computation).

## Why this is correct

- Child-side checks are unaffected: only DELETE and UPDATE-on-the-parent need column-aware filtering.
- Cascading actions (`'cascade'`, `'set null'`, `'set default'`) never reach this code — `buildParentSideFKChecks` already short-circuits at line 286 (`if (action !== 'restrict') continue;`).
- For RESTRICT (the only kind synthesised here) `shouldDefer` is false, so the runtime skip lands ahead of the deferred-queue branch — no row is ever queued for a parent column that didn't change.
- Filter is at runtime rather than plan time because the constraint-check node already receives the flat OLD+NEW row; doing this at plan time would multiply synthesised constraints per touched-column subset.

## Test surface

`packages/quereus/test/logic/41-foreign-keys.sqllogic` — added a dedicated phase covering:

1. Parent UPDATE on a non-FK column with a referencing child row → succeeds (the regression case).
2. Parent UPDATE that touches the FK-referenced PK with a referencing child row → still trips RESTRICT.
3. Two FKs referencing different parent columns: updating only `label` fires only `pmask2_child_label`'s parent-side check; updating only `code` fires only `pmask2_child_code`'s; updating neither (just `extra`) skips both.

(Note: nullable column requires explicit `NULL` in this engine — `extra TEXT NULL`, not bare `extra TEXT`.)

## Validation

- `yarn workspace @quereus/quereus run build` — exit 0.
- `yarn workspace @quereus/quereus run test` — 2643 passing, 2 pending, 0 failing.
- `yarn test:store` not run — runtime change is module-agnostic; the constraint-check path is shared by all storage modules.

## Reviewer focus

- Confirm the deferred-FK path still works for non-RESTRICT FKs: those don't reach `buildParentSideFKChecks` at all (cascading actions only). The new `referencedColumnIndices` would be `undefined` on every other constraint kind, which is correctly handled by the `metadata.referencedColumnIndices` truthiness check.
- The new field is `readonly ReadonlyArray<number>`. The runtime never mutates it — it's only iterated.
- One spot to second-guess: should the OLD/NEW comparison happen even when `metadata.shouldDefer` is true? It's moot here (RESTRICT → not deferrable), but if a future caller routes a `'fk-parent'` check through the deferred path, the column-mask filter still sits before the defer branch and would correctly skip pointless deferred rows.
