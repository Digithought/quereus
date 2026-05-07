description: OR-conflict clause semantics diverge from SQLite — IGNORE doesn't cover NOT NULL/CHECK/FK; REPLACE doesn't substitute DEFAULT for NULL; FAIL/ROLLBACK don't preserve/rollback as specified; column-level ON CONFLICT directives parsed but not applied.
prereq:
files:
  packages/quereus/test/logic/43.1-notnull-or-conflict.sqllogic
  packages/quereus/test/logic/47.2-replace-and-or-clauses.sqllogic
  packages/quereus/test/logic/41-fk-cascade-conflict-and-self-ref.sqllogic
  packages/quereus/test/logic/29.1-column-level-conflict-clause.sqllogic
  packages/quereus/src/runtime/emit/insert.ts
  packages/quereus/src/runtime/emit/update.ts
----

## Problem

OR-conflict resolution is currently scoped narrowly to UNIQUE conflicts and per-statement defaults; SQLite/SQL semantics require it to span all constraint classes and to handle multi-row outcomes correctly. Column-level `ON CONFLICT` directives (`primary key on conflict replace`, etc.) are parsed but never applied as the constraint's default action; declaring a column-level CHECK with a trailing ON CONFLICT entirely fails to parse.

Specific divergences:

- **OR IGNORE** does not skip NOT NULL violations (only UNIQUE).
- **OR IGNORE** does not skip CHECK violations.
- **OR IGNORE** does not skip FK violations.
- **OR REPLACE** does not substitute the column DEFAULT for an explicit NULL on a NOT NULL column.
- **OR FAIL** rolls back already-inserted rows on a later violation; SQLite keeps prior successful rows and stops at the failing row.
- **OR ROLLBACK** does not auto-rollback the enclosing transaction; prior inserts remain visible.
- **Column-level ON CONFLICT directives** (`primary key on conflict replace`, `... on conflict ignore`, etc.) are parsed but ignored at runtime — without an explicit statement-level OR clause the duplicate insert still aborts. Column-level CHECK with trailing ON CONFLICT clauses is not accepted by the parser at all.

## Expected behavior

Match SQLite semantics for `INSERT/UPDATE OR {IGNORE,REPLACE,FAIL,ABORT,ROLLBACK}`:

- **IGNORE**: every constraint class (UNIQUE, NOT NULL, CHECK, FK) on a row produces a silent skip of that row, no error, statement continues.
- **REPLACE**: on NOT NULL violation, substitute the column's DEFAULT if defined; if no DEFAULT, error. On UNIQUE violation, delete the conflicting row(s) and proceed.
- **FAIL**: rows that succeeded prior to the failing row remain inserted; the statement stops at the failing row and reports the error.
- **ROLLBACK**: violation triggers an automatic rollback of the enclosing (or implicit) transaction, then errors.
- **Column-level `ON CONFLICT <action>`**: when no statement-level OR clause is present, the column-level directive becomes the default action for that constraint.

## Reproduction

Each block below is commented `-- TODO bug:` or kept as a behavior-pinning test alongside the bug note. Uncomment / remove the pinning assertion to reproduce.

- `packages/quereus/test/logic/43.1-notnull-or-conflict.sqllogic:9` — `insert or ignore` with NULL into NOT NULL column is rejected instead of silently skipping.
- `packages/quereus/test/logic/47.2-replace-and-or-clauses.sqllogic:134` — `insert or ignore into ck values (2, -5)` with `check (n > 0)` raises instead of skipping.
- `packages/quereus/test/logic/41-fk-cascade-conflict-and-self-ref.sqllogic:11` — `insert or ignore into c_oc values (1, 99)` (orphan FK) errors instead of skipping.
- `packages/quereus/test/logic/43.1-notnull-or-conflict.sqllogic:46` — `insert or replace into t_or_def values (1, null)` does not substitute the column DEFAULT for the NULL.
- `packages/quereus/test/logic/47.2-replace-and-or-clauses.sqllogic:108` — after `insert or fail` of `(1,'a'),(2,'b'),(5,'dup'),(3,'c')` against pre-existing key `5='pre'`, the prior `(1,'a'),(2,'b')` rows are rolled back instead of preserved.
- `packages/quereus/test/logic/47.2-replace-and-or-clauses.sqllogic:122` — `insert or rollback` inside an open transaction does not roll back; prior `insert into rb values (10, 'committed_in_tx')` remains visible.
- `packages/quereus/test/logic/29.1-column-level-conflict-clause.sqllogic` — entire file annotated; column-level `on conflict {replace,ignore,...}` directives don't change duplicate-insert behavior.

## Likely investigation areas

- `packages/quereus/src/runtime/emit/insert.ts`, `packages/quereus/src/runtime/emit/update.ts` — conflict-action dispatch must cover all constraint classes, not just UNIQUE.
- Constraint-check emission for NOT NULL / CHECK / FK — needs to consult the active OR-clause (or column-level default) and apply IGNORE/REPLACE/FAIL/ROLLBACK semantics.
- Schema layer — column-level `ON CONFLICT` directive must be persisted on the column / constraint and consulted as the default when no statement-level clause is specified.
- Parser — accept column-level CHECK with trailing `ON CONFLICT <action>`.
- Transaction layer — ROLLBACK action needs to issue an automatic rollback of the enclosing tx (or implicit auto-commit tx) before raising.
- FAIL semantics — multi-row INSERT loop must commit per-row prior successes instead of treating the statement as one all-or-nothing unit.
