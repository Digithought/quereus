---
description: Review the schema-build + helper plumbing that makes table-level `PRIMARY KEY (...) ON CONFLICT <action>` propagate into PK-conflict resolution.
files:
  packages/quereus/src/schema/table.ts
  packages/quereus/src/schema/manager.ts
  packages/quereus/src/vtab/memory/layer/manager.ts
  packages/quereus-isolation/src/isolated-table.ts
  packages/quereus/test/logic/29.2-table-level-pk-conflict-clause.sqllogic
---

# Review: Table-level `PRIMARY KEY ... ON CONFLICT` propagation

## What changed

### Schema build (option 2 from the source ticket)

- `TableSchema` got a new optional field
  `primaryKeyDefaultConflict?: ConflictResolution` — see
  `packages/quereus/src/schema/table.ts:31`. The field is intentionally
  separate from per-column `defaultConflict` so a table-level
  `PRIMARY KEY (a, b) ON CONFLICT REPLACE` does not clobber any
  column-level `ON CONFLICT` declared on the PK columns themselves.
- `findPKDefinition` and `findConstraintPKDefinition` now return both the
  PK column list and the constraint's `onConflict` action
  (`packages/quereus/src/schema/table.ts:451-543`). Column-level PKs carry
  no constraint-level `ON CONFLICT` — `defaultConflict` is `undefined` in
  that path (column-level `ON CONFLICT` continues to live on
  `ColumnSchema.defaultConflict`).
- `buildColumnSchemas` in `schema/manager.ts` was widened to forward the
  conflict (`packages/quereus/src/schema/manager.ts:671-696`) and the
  build site in `_createTableSchemaFromAST` now threads it into the frozen
  table schema (`packages/quereus/src/schema/manager.ts:891-921`).
- `createBasicSchema` (the minimal-schema helper at
  `schema/table.ts:263`) leaves `primaryKeyDefaultConflict` absent — its
  callers don't parse `ON CONFLICT`.

### Helper updates

Both `resolvePkDefaultConflict` implementations grew a first check for
`schema.primaryKeyDefaultConflict` before iterating PK columns. Precedence
for PK conflicts is now `statement OR > table-level PK default >
column-level defaultConflict on a PK column > ABORT`:

- `packages/quereus/src/vtab/memory/layer/manager.ts:1498-1510`
- `packages/quereus-isolation/src/isolated-table.ts:1320-1336`

The two implementations stay textually equivalent (matching the existing
"Mirrors the helper" comment).

### Tests

- New: `packages/quereus/test/logic/29.2-table-level-pk-conflict-clause.sqllogic`
  exercises a composite table-level PK with each `ON CONFLICT` action:
  - IGNORE — duplicate insert silently dropped (single row remains).
  - REPLACE — duplicate insert silently replaces the existing row.
  - FAIL — duplicate insert errors with `UNIQUE constraint failed`.
  - ROLLBACK — duplicate insert errors with `UNIQUE constraint failed`
    (see "Known gap" below).
  - Statement-level `insert or abort` overrides table-level IGNORE.
  - UPDATE path honors table-level REPLACE and IGNORE (mirrors 29.1
    cases 7+8 but with composite PK).

## Verification

- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn build` — passes across the workspace.
- `yarn workspace @quereus/quereus run test` — **2941 passing, 2 pending,
  0 failing** (memory backend). 29.2 fixture passes; 29.1 stays green.
- `yarn test:store` — 1 failing, but it is **pre-existing and unrelated**:
  `10.5.1-partial-indexes.sqllogic` at line 49 ("Expected error matching
  'UNIQUE' but SQL block executed successfully") fails identically on the
  branch HEAD `503fd079` without these changes (verified by stashing and
  re-running). It's about partial UNIQUE index enforcement in STORE mode,
  not anything this ticket touches.

## Use cases for testing / validation

The reviewer should poke at:
- Composite PKs declared **table-level** with each `ON CONFLICT` action
  (the case the source bug was about — these previously silently
  degraded to ABORT).
- Tables that mix table-level PK `ON CONFLICT` with column-level
  `ON CONFLICT` on a *non*-PK column — they should not interfere.
- Tables with a column-level PK declaration that has `ON CONFLICT` on
  the column itself: the column-level `defaultConflict` still wins as
  the fallback (covered by existing 29.1 cases 1, 2, 7, 8).
- `IsolationModule`-wrapped paths: the isolation overlay's
  pre-check must agree with the wrapped memory module's resolution. This
  is covered indirectly by `yarn test` exercising
  `quereus-isolation`'s own test suite; the isolation-layer's
  `resolvePkDefaultConflict` is now textually equivalent to memory's.
- UPDATE-with-PK-change: cases 6 and 7 of 29.2 cover this. UPDATE has no
  statement-level OR clause (intentionally unsupported, see
  47.2 case 5), so the table-level default is the only path to
  REPLACE/IGNORE on UPDATE.

## Known gap (intentionally out of scope)

The source ticket's acceptance criteria for FAIL and ROLLBACK were:

> FAIL → second insert errors with constraint failure.
> ROLLBACK → second insert errors and the surrounding transaction is
> rolled back.

FAIL's "errors with constraint failure" is satisfied: for a single-row
INSERT, FAIL is indistinguishable from ABORT at the surface. Case 3 of
29.2 verifies this.

ROLLBACK's stronger requirement (auto-rollback of the enclosing
transaction) is **not** satisfied by this change, and the test was
adjusted to assert only the surface-level constraint error. The reason:

- Per-constraint FAIL/ROLLBACK actions are honored end-to-end only when
  raised via `throwForAction()` in
  `packages/quereus/src/runtime/emit/constraint-check.ts` (which throws
  the right `FailConflictError` / `RollbackConflictError` subclass that
  `Database._finalizeImplicitTransaction` recognizes).
- PK conflicts take a different path: the memory / isolation vtab layer
  returns `{ status: 'constraint', constraint: 'unique', ... }` and the
  DML executor throws a generic `ConstraintError`. The translation in
  `dml-executor.ts:translateConflictError` only escalates to
  Fail/Rollback subclasses based on **statement-level** OR — it does not
  consult per-constraint defaults.
- This is a pre-existing limitation, also visible for column-level PK
  `ON CONFLICT FAIL/ROLLBACK` (29.1 doesn't test those for the same
  reason).

Fixing this would require either having the vtab layer throw the
right subclass directly when the resolved action is FAIL/ROLLBACK, or
extending `translateConflictError` to know about per-constraint defaults
for the constraint that failed. Both are runtime/emit changes outside
the schema-build + helper scope this ticket explicitly carved out (see
the source ticket's "Notes for the implementer"). Recommended follow-up:
spawn a separate fix ticket so column-level and table-level
per-constraint FAIL/ROLLBACK both gain real semantics consistently.

## Things to scrutinize

- The `findPKDefinition` signature change widens its return from
  `ReadonlyArray<PrimaryKeyColumnDefinition>` to
  `{ pkDef, defaultConflict }`. Only one caller exists
  (`buildColumnSchemas` in `manager.ts`). I confirmed via
  `find_references` that there are no other in-tree callers, but worth a
  second pass.
- The helper precedence in `resolvePkDefaultConflict`
  (`primaryKeyDefaultConflict` before column-level fallback) is the
  judgment call from option 2 of the source ticket — the rationale is in
  the helper's doc comment and the source ticket's "Resolution
  precedence" section. Confirm this is the desired semantic.
- The new `TableSchema` field is optional; `Object.freeze`'d schemas with
  the field absent keep the existing shape. No other consumer references
  the field — confirm with a project-wide search if you want belt and
  braces.
- Verify the test file's UPDATE cases (29.2 #6 and #7) really exercise
  the table-level helper rather than something else. Case 6 changes
  *both* PK columns to conflict; case 7 same shape but with IGNORE.
