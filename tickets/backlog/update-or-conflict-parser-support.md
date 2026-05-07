---
description: Add `UPDATE OR {IGNORE,REPLACE,FAIL,ABORT,ROLLBACK}` parser support and wire it through to the same constraint-check / dml-executor path as INSERT OR.
prereq: fix-or-conflict-clause-semantics
files:
  packages/quereus/src/parser/parser.ts
  packages/quereus/src/parser/ast.ts
  packages/quereus/src/planner/building/update.ts
  packages/quereus/test/logic/47.2-replace-and-or-clauses.sqllogic
  packages/quereus/test/logic/41-fk-cascade-conflict-and-self-ref.sqllogic
  packages/quereus/test/logic/43.1-notnull-or-conflict.sqllogic
---

## Problem

Quereus's parser does not accept `UPDATE OR <action>` (e.g. `UPDATE OR REPLACE t SET ...`). The `UpdateStmt.onConflict` AST field exists but no production sets it, so the test fixtures pin SQLite-style UPDATE OR behavior as parser-rejected:

- `test/logic/47.2-replace-and-or-clauses.sqllogic:70` — `update or replace uor set code = 'aaa' where id = 2;` errors with "Expected table name".
- `test/logic/41-fk-cascade-conflict-and-self-ref.sqllogic:41` — UPDATE OR IGNORE / OR ABORT noted as "deleted because not parser-supported".
- `test/logic/43.1-notnull-or-conflict.sqllogic:58` — UPDATE OR IGNORE / OR REPLACE noted likewise.

## Expected behavior

`UPDATE OR <action> <tbl> SET ... ` parses with `<action>` ∈ {ROLLBACK, ABORT, FAIL, IGNORE, REPLACE}, populating `UpdateStmt.onConflict`. The plan builder threads it onto the same `ConstraintCheckNode.onConflict` / `DmlExecutorNode.onConflict` plumbing introduced by `fix-or-conflict-clause-semantics`. Engine-level constraint enforcement and the FAIL/ROLLBACK transaction semantics defined there should "just work" for UPDATE once the parser surface is in place.

## Notes

- Mirror the INSERT OR parsing block at `parser.ts:331-340` inside `updateStatement` (`parser.ts:2009`), placed immediately after `UPDATE` and before `tableIdentifier()`.
- Update `building/update.ts:324, :370` to pass `stmt.onConflict` to `DmlExecutorNode` (the prereq ticket already changes the constraint-check side).
- Re-enable the pinned test cases above once the parser accepts the syntax and confirm semantics match the INSERT OR behavior.
