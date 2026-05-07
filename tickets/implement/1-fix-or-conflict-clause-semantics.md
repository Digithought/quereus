---
description: Bring INSERT OR-conflict resolution and column-level ON CONFLICT directives in line with SQLite — IGNORE/REPLACE/FAIL/ROLLBACK must cover NOT NULL/CHECK/FK; column-level directives must persist as the per-constraint default.
prereq:
files:
  packages/quereus/src/parser/parser.ts
  packages/quereus/src/parser/ast.ts
  packages/quereus/src/schema/column.ts
  packages/quereus/src/schema/table.ts
  packages/quereus/src/planner/nodes/constraint-check-node.ts
  packages/quereus/src/planner/building/insert.ts
  packages/quereus/src/planner/building/constraint-builder.ts
  packages/quereus/src/planner/building/foreign-key-builder.ts
  packages/quereus/src/runtime/emit/constraint-check.ts
  packages/quereus/src/runtime/emit/dml-executor.ts
  packages/quereus/src/core/database.ts
  packages/quereus/src/core/database-transaction.ts
  packages/quereus/src/util/async-iterator.ts
  packages/quereus/test/logic/29.1-column-level-conflict-clause.sqllogic
  packages/quereus/test/logic/41-fk-cascade-conflict-and-self-ref.sqllogic
  packages/quereus/test/logic/43.1-notnull-or-conflict.sqllogic
  packages/quereus/test/logic/47.2-replace-and-or-clauses.sqllogic
---

## Goal

Match SQLite semantics for `INSERT OR {IGNORE,REPLACE,FAIL,ABORT,ROLLBACK}` across every constraint class, and honor column-level `ON CONFLICT <action>` directives as the default action for that constraint when no statement-level OR clause is present.

UPDATE OR is intentionally out of scope for this ticket — the parser does not currently accept it, and the relevant test cases are pinned as not-supported. A separate ticket can pick up UPDATE OR parser/runtime support later.

## Current state (as of research)

### Where the OR clause is read and threaded today

- Parser: `packages/quereus/src/parser/parser.ts:330-340` reads `INSERT OR <action>` into `InsertStmt.onConflict`. `updateStatement` (`parser.ts:2009`) does not parse `UPDATE OR` at all (AST has the field, no production sets it).
- Plan builder: `packages/quereus/src/planner/building/insert.ts:576` threads `stmt.onConflict` onto `DmlExecutorNode.onConflict`. **Crucially, it is not passed to `ConstraintCheckNode`** (`packages/quereus/src/planner/nodes/constraint-check-node.ts:21`).
- Runtime executor: `packages/quereus/src/runtime/emit/dml-executor.ts:281` forwards `onConflict` to `vtab.update(...)`.
- Memory vtab: `packages/quereus/src/vtab/memory/layer/manager.ts:475+` honors IGNORE/REPLACE **only for UNIQUE/PK conflicts** (`checkUniqueViaIndex`/`checkUniqueByScanning` at lines 765 and 804).
- Engine constraint check: `packages/quereus/src/runtime/emit/constraint-check.ts` does NOT receive `onConflict`. NOT NULL throws unconditionally (line 188); CHECK throws unconditionally (line 247); FK existence checks pass through this same node (built by `buildChildSideFKChecks`) and also throw unconditionally.

### Column-level `ON CONFLICT` directives — parsed but discarded

- Parser captures `<column-constraint> ON CONFLICT <action>` correctly for PRIMARY KEY / NOT NULL / NULL / UNIQUE (`parser.ts:3471, 3480, 3485, 3490`) — they end up on `ColumnConstraint.onConflict`.
- AST is read in `packages/quereus/src/schema/table.ts:114-150` (`columnDefToSchema`) — the `onConflict` field is ignored. `ColumnSchema` (`packages/quereus/src/schema/column.ts`) has no slot for it.
- For column-level `CHECK ( … ) ON CONFLICT <action>` the parser does NOT call `parseConflictClause()` after consuming the close-paren (`parser.ts:3501`). The trailing `ON CONFLICT` is left in the token stream and the next iteration of the column-constraint loop fails with "forget a comma before 'on'".
- For table-level constraints, the parser does store `onConflict` on `TableConstraint`, but it is similarly ignored when building the table schema.
- `RowConstraintSchema` (`packages/quereus/src/schema/table.ts:307`) and `UniqueConstraintSchema` / `ForeignKeyConstraintSchema` have no `defaultConflict` field.

### Transaction layer

- `packages/quereus/src/core/database.ts:397` — `_rollbackTransaction()` rolls back the active transaction across all connections.
- `packages/quereus/src/core/database.ts:438` — `_finalizeImplicitTransaction(success)` only acts when the current transaction is implicit (autocommit).
- Savepoints exist: `_createSavepoint`, `_rollbackToSavepoint`, `_releaseSavepoint` on `Database` (~line 1172), implemented by the transaction manager at `packages/quereus/src/core/database-transaction.ts`.
- Statement-level rollback today: `packages/quereus/src/util/async-iterator.ts:31-117` calls `runCleanup(false)` when an iterator throws, which routes through `_finalizeImplicitTransaction(false)` → `_rollbackTransaction()`. So a statement-level error rolls back **only when in an implicit transaction**; inside an explicit `BEGIN…COMMIT` the prior rows of a failing INSERT remain (this is correct for IGNORE-style behavior, wrong for ROLLBACK).

### Multi-row INSERT atomicity

- `dml-executor.ts:runInsert` (line 242) iterates rows and calls `vtab.update()` per row. There is no per-row savepoint. When a later row throws, prior `_recordInsert` calls remain in the memory layer until the implicit-tx rollback kicks in. That happens to give the correct OR ABORT result in autocommit mode, but it gives the **wrong** OR FAIL result (FAIL must keep prior rows) and the wrong OR ROLLBACK result inside an explicit tx (ROLLBACK must auto-rollback the explicit tx).

### REPLACE → DEFAULT substitution on NOT NULL

- No code exists for this today. `ColumnSchema.defaultValue` carries the parsed expression but is consulted only in `createRowExpansionProjection` for omitted columns (`insert.ts:118-138`), not for explicit-NULL substitution under REPLACE.

## Design

### Schema — persist column-level / constraint-level conflict defaults

- Add `defaultConflict?: ConflictResolution` to:
  - `ColumnSchema` (per-column, applies to the column's NOT NULL and PK / UNIQUE membership when the constraint is column-level)
  - `RowConstraintSchema` (per CHECK constraint, table-level or column-level)
  - `UniqueConstraintSchema` (per UNIQUE/PK constraint, table-level or column-level)
  - `ForeignKeyConstraintSchema` (per FK, mostly for completeness; SQLite supports it)
- Populate them in `columnDefToSchema` (column case) and the table-schema builder (table-constraint case) from the AST `onConflict` field that's already parsed.
- Selection rule at constraint-evaluation time: **statement-level OR clause wins**; if absent, fall back to the constraint's `defaultConflict`; if absent, ABORT.

### Parser — column-level CHECK ON CONFLICT

- After consuming the close-paren in the column-level CHECK production (`parser.ts:3500`), call `parseConflictClause()` and stash the result on the `ColumnConstraint.check` AST. Update `ColumnConstraint` AST shape so the `'check'` variant can carry `onConflict`.

### Plan — thread `onConflict` into ConstraintCheckNode

- Add `onConflict?: ConflictResolution` field (constructor + `withChildren`) on `ConstraintCheckNode`.
- `building/insert.ts` and `building/update.ts`: pass `stmt.onConflict` to the new field.
- The constraint-check emitter receives this and uses it as the per-row "active OR action" when no per-constraint default overrides it.

### Runtime — engine-level constraint enforcement honors `onConflict`

In `runtime/emit/constraint-check.ts`, when a check fails, resolve the effective action using `pickAction(stmtOR, constraint.defaultConflict)` and apply it:

| Check class | IGNORE | REPLACE | FAIL | ABORT | ROLLBACK |
|---|---|---|---|---|---|
| NOT NULL (column has DEFAULT) | skip row | substitute DEFAULT, keep row | throw* | throw | throw + db rollback |
| NOT NULL (no DEFAULT) | skip row | throw | throw* | throw | throw + db rollback |
| CHECK | skip row | throw (REPLACE does not mask CHECK — confirmed by test 47.2 case 10) | throw* | throw | throw + db rollback |
| FK existence (child→parent) | skip row | throw (SQLite would propagate to ON DELETE CASCADE on the conflicting parent — out of scope; document as ABORT-equivalent for now and add a follow-up if needed) | throw* | throw | throw + db rollback |
| UNIQUE / PK | (handled at vtab level via `onConflict` arg) — pass through |

`throw*` for FAIL is a sentinel error class (`FailConflictError extends ConstraintError`) that the cleanup wrapper recognizes — see "Statement-level rollback / FAIL semantics" below.

#### NOT NULL → DEFAULT substitution (REPLACE)

- For each NOT NULL column with a `defaultValue`, pre-build a default evaluator at plan time and pass it into the constraint-check node alongside the existing constraint evaluators. (Reuse `buildExpression(...)` on the AST default expression.)
- At runtime, when REPLACE applies and the new value is NULL, evaluate the default and write it into the flat row at the NEW position before yielding. Re-check NOT NULL after substitution (in case the default evaluates to NULL).

#### Skipping rows under IGNORE

- The constraint-check generator at `constraint-check.ts:111-128` iterates rows and yields one per input. To skip, simply `continue` instead of yielding. The downstream dml-executor then never sees the row, which is the right behavior.

### Statement-level rollback / FAIL / ROLLBACK semantics

The trickiest piece. Two complementary mechanisms:

#### a) Per-row savepoint for OR FAIL

Wrap each row's mutation in a per-row savepoint inside `runInsert` (and only when `onConflict === FAIL`):

```
for each row:
  savepointName = sp_${counter++}
  await db._createSavepoint(savepointName)
  try:
    do constraint-check + vtab.update + bookkeeping
    await db._releaseSavepoint(savepointName)
  catch (e):
    await db._rollbackToSavepoint(savepointName)
    await db._releaseSavepoint(savepointName)
    throw e   // propagates as FailConflictError so the iterator-level cleanup commits prior rows
```

We could always use the savepoint, but it adds per-row overhead. For ABORT/IGNORE/REPLACE the existing path is fine — they don't need to preserve prior rows on a later throw (ABORT explicitly wants the opposite, and IGNORE/REPLACE never throw).

#### b) Iterator-level cleanup recognizes FailConflictError

`util/async-iterator.ts` cleanup currently calls `runCleanup(false)` (rollback) on any error. Extend it: if the error is `instanceof FailConflictError`, call `runCleanup(true)` (commit) instead, then re-throw. This preserves prior rows in autocommit mode. Inside an explicit tx, no rollback was happening anyway, so the prior rows naturally survive.

#### c) Auto-rollback on OR ROLLBACK

Define `RollbackConflictError extends ConstraintError`. When the runtime resolves an effective action of ROLLBACK (engine-level constraint or vtab-level UNIQUE under ROLLBACK), it throws this error. The iterator cleanup detects it and calls `db._rollbackTransaction()` directly (bypassing the implicit-vs-explicit gate in `_finalizeImplicitTransaction`), then re-throws. After this, any open explicit transaction has been rolled back.

For the vtab UNIQUE-under-ROLLBACK case, the memory module's `manager.ts` returns a `'constraint'` UpdateResult; the dml-executor at line 349 currently throws `ConstraintError`. Update that path to throw `RollbackConflictError` when `onConflict === ROLLBACK`.

### UPDATE

- `building/update.ts:324` and `:370` currently pass `undefined` to `DmlExecutorNode` for `onConflict`. Pass `stmt.onConflict` through (it will be undefined for now until the parser supports UPDATE OR — left as a follow-up).
- The constraint-check infrastructure works the same way for UPDATE; the engine-level OR plumbing should be operation-agnostic.

## Reproductions to un-pin (turn TODO bugs into live tests)

- `test/logic/43.1-notnull-or-conflict.sqllogic` — un-comment block at line 9 (NOT NULL + IGNORE) and line 46 (NOT NULL + REPLACE → DEFAULT).
- `test/logic/47.2-replace-and-or-clauses.sqllogic` — un-comment line 104-105 (FAIL preserves prior rows), line 122-123 (ROLLBACK auto-rollback), line 138-140 (CHECK + IGNORE).
- `test/logic/41-fk-cascade-conflict-and-self-ref.sqllogic` — un-comment block at line 11 (FK + IGNORE).
- `test/logic/29.1-column-level-conflict-clause.sqllogic` — rewrite cases 1-4 to assert the SUCCESSFUL semantics (column-level directive applied, no error, expected row counts), and rewrite case 5 to assert the parser accepts `CHECK (...) ON CONFLICT IGNORE`. Case 6 (statement-level OR overrides column-level directive) already pins the right behavior; it should still pass.

## Out of scope / follow-ups

- UPDATE OR parser support — distinct ticket. Tests in 47.2 (case 5) and 41 (case 2) and 43.1 (case 4) currently pin "not supported".
- REPLACE on FK with `ON DELETE CASCADE/SET NULL` cascading the parent row's deletion — SQLite quirk; document as ABORT-equivalent for now and add a follow-up if a real-world need surfaces.
- Performance: per-row savepoints for OR FAIL are O(rows) overhead. If profiling shows this in hot paths, revisit (e.g., lazy savepoint that only opens once we know we'll need rollback).

## TODO

### Phase 1 — schema + parser plumbing

- Add `defaultConflict?: ConflictResolution` to `ColumnSchema`, `RowConstraintSchema`, `UniqueConstraintSchema`, `ForeignKeyConstraintSchema`.
- Populate `defaultConflict` in `columnDefToSchema` (`schema/table.ts`) and table-schema construction from AST `onConflict`.
- Fix `parser.ts:3493-3501` to call `parseConflictClause()` after column-level `CHECK ( ... )`. Update AST shape for `ColumnConstraint` `'check'` variant to carry `onConflict`. Same audit on table-level CHECK.
- Tighten `tableConstraint`'s CHECK production (`parser.ts:3583-3591`) to also call `parseConflictClause()`.

### Phase 2 — plan-level threading

- Add `onConflict?: ConflictResolution` to `ConstraintCheckNode` (constructor, `withChildren`, `getLogicalAttributes`).
- `building/insert.ts` and `building/update.ts`: pass `stmt.onConflict` to `ConstraintCheckNode`.
- `building/update.ts:324, :370`: stop passing `undefined` for `DmlExecutorNode.onConflict`; pass `stmt.onConflict` through.
- Pre-build per-NOT-NULL-column DEFAULT evaluators in `building/insert.ts` (or a shared helper) and pass them onto the constraint-check node so REPLACE substitution can run without re-walking the AST.

### Phase 3 — engine-level constraint enforcement honors onConflict

- Implement `pickAction(stmtOR, defaultConflict)` selector helper.
- `runtime/emit/constraint-check.ts`:
  - Pass `onConflict` and per-constraint defaults into `checkConstraints`.
  - NOT NULL: IGNORE → skip; REPLACE → substitute DEFAULT (if present) or throw if no default; FAIL → throw `FailConflictError`; ROLLBACK → throw `RollbackConflictError`.
  - CHECK: IGNORE → skip; REPLACE → throw (REPLACE does not mask CHECK); FAIL/ROLLBACK as above.
  - FK (child→parent existence): same as CHECK except REPLACE → throw for now (with comment pointing at the SQLite cascade quirk).
- "Skip" path: `continue` in the row loop, so the row never reaches the dml-executor.
- "Substitute DEFAULT" path: rewrite the flat-row's NEW slice in place and re-check NOT NULL.

### Phase 4 — transaction semantics for FAIL and ROLLBACK

- Define `FailConflictError` and `RollbackConflictError` in `common/errors.ts`, both extending `ConstraintError`.
- `runtime/emit/dml-executor.ts:runInsert`: when `plan.onConflict === FAIL`, wrap each row's mutation block in `db._createSavepoint` / `_releaseSavepoint`, with `_rollbackToSavepoint` on error before rethrowing.
- `dml-executor.ts:349` (and the parallel update / delete throw sites): use `RollbackConflictError` when effective action is ROLLBACK, `FailConflictError` when effective action is FAIL. Otherwise the current `ConstraintError` is fine.
- `util/async-iterator.ts`: in the cleanup path, branch on error type — `FailConflictError` → commit prior rows; `RollbackConflictError` → call `db._rollbackTransaction()` unconditionally (covers explicit transactions); other errors → existing rollback-if-implicit path.

### Phase 5 — tests

- Un-comment / rewrite the TODO bug blocks listed under "Reproductions to un-pin" and confirm they pass.
- Add coverage for column-level ON CONFLICT in 29.1 cases 1-5 (including the parser fix for CHECK).
- Add a small targeted fixture for OR FAIL combined with engine-level constraints (NOT NULL/CHECK), since the existing 47.2 case 7 only covers UNIQUE+FAIL.
- Run `yarn test` (memory vtab, default for agents). Skip `yarn test:store` unless touching store-specific paths.
- Run `yarn lint` in `packages/quereus` (single-quote globs on Windows).

### Phase 6 — docs

- Update `docs/sql.md` (or wherever conflict resolution is documented) to describe the per-constraint default vs. statement-level override precedence and the FAIL/ROLLBACK semantics.
- Note the UPDATE OR follow-up.
