description: Cross-check SQLite INSERT/UPDATE/DELETE/UPSERT/RETURNING/REPLACE tests against Quereus and write fixtures for gaps
prereq:
files: docs/sqlite-test-crosscheck.md, docs/sqlite-test-crosscheck-process.md, packages/quereus/test/logic/
----

## Scope

For each `unreviewed` row in the **"DML (INSERT, UPDATE, DELETE, UPSERT, RETURNING)"** section of `docs/sqlite-test-crosscheck.md`: examine the SQLite source against existing Quereus coverage, write tests for any uncovered scenarios, then mark the row `reviewed (<handle>, date)` or `n/a (<reason>)`.

In-scope:
- `insert.test`, `insert2.test` – `insert5.test`
- `update.test`, `update2.test`, `update_from.test`, `updatecursor.test`
- `delete.test`, `delete2.test` – `delete4.test`
- `upsert.test`, `upsert2.test` – `upsert4.test`
- `returning1.test`
- `replace.test`
- `conflict.test`, `conflict2.test` – `conflict4.test`

## Shared rules

Read `docs/sqlite-test-crosscheck-process.md` first.

## Critical constraints (override default tess behavior)

- **Do not run tests, build, or lint.**
- **Do not modify engine code.**
- **Do not file follow-up tickets** for gaps.
- **Do not mirror SQLite tests in bulk.**
- **`n/a` rows get no fixture.**

## Category-specific notes

- Existing coverage: `01-basic.sqllogic` (basics), `47-upsert.sqllogic`, `42-returning.sqllogic`, `44-orthogonality.sqllogic`, `90.4-dml-errors.sqllogic`, `29-constraint-edge-cases.sqllogic`, `102-unique-constraints.sqllogic`.
- `INSERT … SELECT`, `INSERT … VALUES (multi-row)`, `INSERT … DEFAULT VALUES` — pin down each.
- `UPDATE … FROM` (UPDATE with join) — verify support.
- `UPDATE … SET (a,b,c) = (subquery)` — column-list assignment.
- `DELETE` with subquery, with join (SQLite `DELETE … FROM t WHERE rowid IN (…)` is rowid-bound — `n/a` for the rowid form, but the multi-row delete via PK is fair).
- UPSERT: `ON CONFLICT (cols) DO UPDATE SET …` — multi-target conflict, partial constraint match, excluded.col references.
- `INSERT OR REPLACE`/`OR IGNORE`/`OR ABORT`/`OR FAIL`/`OR ROLLBACK` — Quereus's conflict-resolution surface may differ. Pin it down per clause.
- RETURNING with computed expressions, RETURNING in DELETE/UPDATE/INSERT/UPSERT — `42-returning.sqllogic` covers basics; check edge cases (RETURNING on no-op upsert, etc.).
- Quereus has no rowid — any test using `INSERT … VALUES(NULL, …)` to autogen a rowid is `n/a`.
- `last_insert_rowid()` / `changes()` / `total_changes()` — `n/a`.

## TODO

- [ ] Read process doc and assigned section of index doc
- [ ] Dispatch subagents (one per SQLite source file, parallel batches of 4–8)
- [ ] Collate reports; write tests for any uncovered scenarios
- [ ] Update each row's Status to `reviewed (<handle>, date)` or `n/a (<reason>)`
- [ ] Do not run tests; do not build

## Output

Move to `tickets/review/`. Summary as standard.
