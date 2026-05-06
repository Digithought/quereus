description: Cross-check SQLite DDL, view, and constraint tests against Quereus and write fixtures for gaps
prereq:
files: docs/sqlite-test-crosscheck.md, docs/sqlite-test-crosscheck-process.md, packages/quereus/test/logic/, docs/schema.md
----

## Scope

For each `unreviewed` row in the **"DDL (CREATE/ALTER/DROP, views, indexes)"** section of `docs/sqlite-test-crosscheck.md` (**except** the index rows, which are owned by `5-sqlite-xref-indexes.md`): examine the SQLite source against existing Quereus coverage, write tests for any uncovered scenarios, then mark the row `reviewed (<handle>, date)` or `n/a (<reason>)`.

In-scope:
- `createtab.test`, `tableopts.test`
- `alter.test`, `altertbl.test`, `alter2.test` – `alter4.test`
- `view.test`
- `default.test`
- `notnull.test`, `notnull2.test`
- `unique.test`, `unique2.test`
- `check.test`
- `fkey1.test` – `fkey9.test`
- `generated.test`

## Shared rules

Read `docs/sqlite-test-crosscheck-process.md` first. Also read `docs/schema.md` for Quereus's schema model.

## Critical constraints (override default tess behavior)

- **Do not run tests, build, or lint.**
- **Do not modify engine code.**
- **Do not file follow-up tickets** for gaps.
- **Do not mirror SQLite tests in bulk.**
- **`n/a` rows get no fixture.**

## Category-specific notes

- **NOT NULL inverts**: Quereus columns default to NOT NULL (Third Manifesto). SQLite's `notnull*.test` largely tests the opposite default. The relevant test is "is the column nullable as declared?" — adapt expectations rather than transliterate. Fixture `43-default-nullability.sqllogic` covers Quereus's default.
- **No rowid**: SQLite `WITHOUT ROWID`, `INTEGER PRIMARY KEY`-as-rowid, `AUTOINCREMENT` — `n/a`. The `INTEGER PRIMARY KEY` test cases survive only as plain PK semantics.
- **VTab-centric**: `CREATE TABLE` in Quereus accepts a `USING module(...)` clause. SQLite `createtab.test` doesn't. Tests of plain `CREATE TABLE` syntax apply; module-related semantics are Quereus-specific (already covered).
- ALTER TABLE: existing coverage at `41-alter-table.sqllogic`, `41.1-alter-pk.sqllogic`, `41.2-alter-column.sqllogic`, `90.2-alter-table-errors.sqllogic`. SQLite's ALTER surface is small (RENAME, ADD COLUMN, DROP COLUMN, RENAME COLUMN). Check parity.
- VIEW: `08-views.sqllogic`, `93-ddl-view-edge-cases.sqllogic`. Check WITH/CTE in views, recursive views, `CREATE TEMP VIEW` (likely `n/a`), `IF NOT EXISTS`.
- DEFAULT expressions: `03.4-defaults.sqllogic`. Determinism enforcement is Quereus-specific — non-deterministic defaults are rejected. Fixtures should respect this.
- CHECK constraints: `40-constraints.sqllogic`, `29-constraint-edge-cases.sqllogic`. Quereus separates row-level (immediate) vs cross-table (deferred); see `docs/architecture.md` § Constraints.
- UNIQUE: `102-unique-constraints.sqllogic`. Multi-column UNIQUE, partial UNIQUE indexes (likely `n/a` if Quereus lacks).
- FOREIGN KEY: `41-foreign-keys.sqllogic`, `41-fk-cross-schema.sqllogic`. Check ON DELETE/UPDATE CASCADE/SET NULL/RESTRICT/NO ACTION/SET DEFAULT — last two may be partial. `MATCH FULL/PARTIAL/SIMPLE` — likely `n/a`.
- GENERATED COLUMNS: `41-generated-columns.sqllogic`. STORED vs VIRTUAL semantics; Quereus may only support one.
- `pragma foreign_keys = ON/OFF` — `n/a` if Quereus is always-on.

## TODO

- [ ] Read process doc, schema doc, assigned section (skip index-related rows — separate ticket owns those)
- [ ] Dispatch subagents (one per SQLite source file, parallel batches of 4–8)
- [ ] Collate reports; write tests for any uncovered scenarios
- [ ] Update each row's Status to `reviewed (<handle>, date)` or `n/a (<reason>)`
- [ ] Do not run tests; do not build

## Output

Move to `tickets/review/`. Summary as standard. Given the size of this ticket (~26 SQLite files), explicitly note in the review summary if you split into a `5-sqlite-xref-ddl-constraints-part2.md` sibling.
