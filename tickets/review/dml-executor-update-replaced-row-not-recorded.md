---
description: Review the UPDATE-path fix for unrecorded `result.replacedRow` in `dml-executor.ts`. The UPDATE generator now records a DELETE for the evicted row, cascades FK actions, and emits an auto data event — analogous to the INSERT path's handling.
prereq:
files:
  packages/quereus/src/runtime/emit/dml-executor.ts
  packages/quereus/test/logic/29.1-column-level-conflict-clause.sqllogic
---

## Change summary

`packages/quereus/src/runtime/emit/dml-executor.ts` (UPDATE path,
`runUpdate`): after a successful `vtab.update`, the executor now inspects
`result.replacedRow`. When the vtab returns one (column-level
PK-on-conflict REPLACE or statement-level `OR REPLACE` evicting an
occupied PK during a PK-change UPDATE), the executor:

- calls `ctx.db._recordDelete(...)` for the evicted row,
- runs `executeForeignKeyActions(db, tableSchema, 'delete', replacedRow)`,
- emits an auto `'delete'` event when there are non-native-event listeners.

The eviction handling runs **before** the existing
`_recordUpdate` / FK update-cascade / auto-event block for the moved
row. The ticket suggested post-update was fine, but evict-first was
chosen during implement because:

1. It matches the journal order of the memory layer
   (`manager.ts:657-659` records `delete(newPk, evicted)` before the
   move).
2. It matches SQLite's documented REPLACE semantics (the implicit
   DELETE happens first).
3. With `ON UPDATE CASCADE`, evict-last would first relocate children
   onto PK_new and then the eviction's `ON DELETE CASCADE` would wipe
   them. Evict-first leaves the move-cascade observing the post-eviction
   child set.

## Tests added

`packages/quereus/test/logic/29.1-column-level-conflict-clause.sqllogic`
gains sections 9 and 10.

- **§9** — `parent_evict` with `primary key on conflict replace` plus
  `child_evict ... on delete cascade`. Only a child of the evicted row
  is present (any child of the moved row would hit the default
  `on update restrict` and block the test). The UPDATE that moves
  `parent_evict.id` onto an occupied PK is expected to cascade-delete
  the evicted parent's child.
- **§10** — same shape but `on delete set null`; the child's
  `parent_id` is declared `null` (existing repo convention for SET NULL
  targets) and verified to land at NULL after the eviction.

Section 9 verifies the new `executeForeignKeyActions('delete', ...)`
call. Section 10 verifies the FK action runs through the same dispatch
for SET NULL.

## Deviations from the ticket

The ticket's sample SQL also kept a child of the moved row (`(10, 1)`)
and expected it to end up with `parent_id=2`. That implies
`on update cascade` semantics, but the FK definition omitted them — and
Quereus's default `onUpdate` is `'restrict'`
(`packages/quereus/src/schema/manager.ts:781,815`), so the move would
abort on the RESTRICT pre-check before any of the new code runs. The
tests were simplified to keep the focus on the eviction cascade
(removing the irrelevant child of the moved row). The change to the
executor itself still mirrors the ticket; only the test setup was
trimmed.

## Validation performed

- `yarn workspace @quereus/quereus run test` — 2941 passing, 2 pending,
  0 failing. Sections 9 and 10 pass; the existing
  29.1-column-level-conflict-clause suite (sections 1-8) still passes.
- `yarn workspace @quereus/quereus run lint` — clean (exit 0).

## Reviewer attention

- **Auto-event coverage gap (documented deferral).** The ticket asked
  for a direct test that subscribes to `DatabaseEventEmitter` and asserts
  a `'delete'` event fires for the evicted row. The sqllogic harness
  doesn't easily surface the event stream, so the test additions cover
  the FK cascade path (which shares the `needsAutoEvents` /
  `_recordDelete` gate) but not the event emission itself directly.
  A dedicated unit test against the emitter in `packages/quereus/test/`
  is still missing — worth adding in a follow-up if the reviewer wants
  full coverage of the auto-event branch on this path.
- **`OR REPLACE` statement-level form not test-covered.** Sections 9 and
  10 rely on the column-level `primary key on conflict replace` to drive
  REPLACE. They don't exercise `update or replace ...` reaching the same
  code path. The memory module routes both to
  `performUpdateWithPrimaryKeyChange`, so the executor change should
  cover both, but the statement-level form has no explicit logic test
  yet.
- **`yarn test:store` not run.** Default agent runner uses the
  memory-backed vtab. If the LevelDB store module surfaces `replacedRow`
  in `UpdateResult` with the same semantics as the memory module, the
  new behavior should apply there as well; verify or defer to CI.
- **Ordering choice (evict-first) is a semantic decision, not just a
  cosmetic one.** Documented in `dml-executor.ts:519-526`. The ticket's
  suggested post-update ordering would silently miscascade with
  `ON UPDATE CASCADE` + `ON DELETE CASCADE` combinations on the same
  child table; please confirm the evict-first choice before sign-off.
- **No statement-level conflict mode coverage of `OR IGNORE`/`OR ABORT`
  interacting with eviction.** Tests only cover the
  column-level-conflict-clause path. The `runUpdate` body doesn't branch
  on `plan.onConflict` around the new code, so it should be a no-op
  for IGNORE/ABORT (no `replacedRow` returned), but a regression test
  would harden it.

## End
