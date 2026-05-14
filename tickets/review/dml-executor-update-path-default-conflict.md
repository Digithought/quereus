---
description: Review — UPDATE path in `dml-executor.ts` no longer coerces `plan.onConflict` to ABORT, so column-level `defaultConflict` directives are honored on plain UPDATE. Also teaches the memory module's PK-change update path to handle `REPLACE` (not just `IGNORE`).
files:
  packages/quereus/src/runtime/emit/dml-executor.ts
  packages/quereus/src/vtab/memory/layer/manager.ts
  packages/quereus/test/logic/29.1-column-level-conflict-clause.sqllogic
  packages/quereus-store/test/isolated-store.spec.ts
prereq:
---

# Summary

Two coupled fixes so that column-level `ON CONFLICT <action>` directives
declared on a PRIMARY KEY are honored on the UPDATE path (the INSERT path
already worked):

1. **`packages/quereus/src/runtime/emit/dml-executor.ts` (UPDATE path, ~line 495–504).**
   Previously the executor passed `onConflict: plan.onConflict ?? ConflictResolution.ABORT`
   to `vtab.update(...)`, which forced ABORT whenever the statement had no
   `OR <action>` clause and prevented the vtab from falling back to its
   per-constraint `defaultConflict` directive.  Now it forwards
   `plan.onConflict` raw (`undefined` when there's no statement-level OR
   clause).  The memory module already treats `undefined` as ABORT when no
   constraint default applies, so behavior is unchanged for plain tables —
   only tables with column-level directives gain the new behavior.

   The DELETE path was left as `?? ConflictResolution.ABORT`; DELETE
   doesn't carry a row that could trigger a column-level constraint, so the
   coercion is benign and not required for this ticket's acceptance.

2. **`packages/quereus/src/vtab/memory/layer/manager.ts`,
   `performUpdateWithPrimaryKeyChange` (~line 639–683).**
   Was already handling `IGNORE` on a PK collision under UPDATE.  Added a
   sibling `REPLACE` branch that:
   - records a delete for the row currently at the new PK,
   - records a delete for the old PK,
   - records an upsert at the new PK,
   - returns `{ status: 'ok', row: newRowData, replacedRow: existingRowAtNewKey }`.

   This latent gap only became reachable once the executor stopped coercing
   to ABORT.

# What to verify

## Behavior

- Plain UPDATE on a table whose PK is declared `ON CONFLICT REPLACE` and
  whose new key collides with an existing row: the existing row is
  silently replaced; the moved row's non-PK columns are preserved.
- Plain UPDATE on a table whose PK is declared `ON CONFLICT IGNORE` and
  whose new key collides: UPDATE is a silent no-op; both rows remain
  unchanged at their original keys.
- Plain UPDATE without a colliding new PK still works (no regressions on
  non-PK-changing updates, or PK-changing updates where the new PK is
  vacant).
- Plain UPDATE on a table with **no** column-level directive still
  defaults to ABORT (treat `undefined` → ABORT preserved).
- Statement-level `OR <action>` is still honored on INSERT.  (Note:
  `UPDATE OR <action>` is deliberately NOT supported — see
  `docs/sql.md` § DML, and the existing pin in
  `42.1-returning-extras.sqllogic` § 7. The implementer dropped the
  `UPDATE OR ABORT` case from the original spec for this reason.)

## Tests

- `packages/quereus/test/logic/29.1-column-level-conflict-clause.sqllogic`
  — sections 7 and 8 cover the REPLACE/IGNORE UPDATE-path cases against
  the in-memory vtab.
- `packages/quereus-store/test/isolated-store.spec.ts` — `'PK column-level
  REPLACE: plain UPDATE that hits a PK collision replaces the row'` and
  `'PK column-level IGNORE: plain UPDATE that hits a PK collision is a
  silent no-op'` cover the same behavior against the isolated store
  module.

## Validation already run by the implementer

- `yarn workspace @quereus/quereus test` — 2940 passing, 2 pending.
- `yarn workspace @quereus/store test` — 252 passing.

Store-mode (`yarn test:store` — quereus logic suite against the LevelDB
store module) was **not** exercised here.  Worth confirming during review
if you want belt-and-suspenders coverage of the store path, since the
isolated-store spec is the closest proxy but not identical.

# Known gaps / things to scrutinize

- **DELETE-path coercion left in place.**  Intentional per the implementer
  (DELETE has no incoming row to violate column constraints), but reviewer
  should sanity-check whether any DELETE-side conflict semantics depend on
  the executor passing `plan.onConflict` raw.  In particular, FK-triggered
  cascading deletes via this path don't carry a column-level directive
  today; if that ever changes, revisit.
- **`UPDATE OR <action>` not supported.**  The original ticket listed an
  `UPDATE OR ABORT` case in acceptance; the implementer dropped it because
  the parser rejects the syntax and an existing test pins that.  Confirm
  the reviewer is comfortable with this scope reduction, or open a
  follow-up to widen parser support for `UPDATE OR <action>` (out of
  scope here).
- **PK-change UPDATE with non-PK UNIQUE constraints.**  The new REPLACE
  branch fires before the UNIQUE-constraint check
  (`checkUniqueConstraints`) on the new key.  That matches the IGNORE
  branch's ordering and avoids a redundant rollback, but means a row that
  would *also* violate a separate UNIQUE constraint at the new position
  is not surfaced when REPLACE is the action — REPLACE wins, the
  conflicting PK row is evicted, and the other UNIQUE conflict (if any)
  is not re-checked.  Worth a second look that this is the desired
  precedence.
- **`replacedRow` return field on the new REPLACE branch.**  The IGNORE
  branch returns `{ status: 'ok', row: undefined }`; the new REPLACE
  branch returns `{ status: 'ok', row: newRowData, replacedRow:
  existingRowAtNewKey }`.  Verify downstream consumers (change tracking,
  returning-clause emission) treat `replacedRow` correctly under UPDATE,
  not just under INSERT-with-REPLACE.

# TODO for reviewer

- Read `dml-executor.ts` UPDATE path (around line 495) and verify the
  diff matches the description above.
- Read `manager.ts` `performUpdateWithPrimaryKeyChange` (line 639+) and
  confirm the REPLACE branch ordering / return shape.
- Read the new sections of `29.1-column-level-conflict-clause.sqllogic`
  (sections 7–8) and the two new `it(...)` cases in
  `isolated-store.spec.ts` (around line 513 & 526).
- Decide whether store-mode (`yarn test:store`) needs to be exercised
  before complete/.
- Decide whether the gaps above need follow-up tickets, fix inline if
  minor, or accept as-is.
