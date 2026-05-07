description: ALTER TABLE ADD COLUMN with column-level CHECK / REFERENCES not enforced; negative-literal DEFAULT rejected
prereq:
files:
  packages/quereus/test/logic/41.4-alter-add-column-constraints.sqllogic
  packages/quereus/test/logic/90.2.1-alter-extra-errors.sqllogic
  packages/quereus/src/planner/building/alter-table.ts
  packages/quereus/src/runtime/emit/alter-table.ts
  packages/quereus/src/planner/building/foreign-key-builder.ts
  packages/quereus/src/parser/parser.ts
----

## Problem

`alter table ... add column` accepts column-level constraint syntax but fails to wire the new constraints into the runtime constraint engine. It also chokes on a valid DEFAULT literal form.

Sub-bugs:

- **Column-level CHECK on the added column is not enforced on later inserts.** The CHECK constraint is parsed (no DDL error) but subsequent INSERTs that violate it succeed.
- **Column-level CHECK on the added column is not validated against backfill.** When the column has a NOT NULL + DEFAULT combination whose default value violates the CHECK, the ALTER itself should fail; instead it silently succeeds and leaves rows that violate the constraint.
- **`references parent(col)` (column-level FK) on the added column is not enforced on later inserts.** The FK is parsed without complaint but never participates in child-side validation.
- **Negative-literal DEFAULT is rejected as "no DEFAULT".** `add column r real default -123.0` (and parenthesised `default (-123.0)`) fails at parse / build time, while a positive-literal `default 123.0` works.

## Expected behavior

`add column` should be a strict superset of the column-clause grammar from `create table` for the same column types of constraint:

- `check (...)` declared on the new column is enforced for all subsequent inserts/updates and is also evaluated against backfilled values; if backfill violates the CHECK the ALTER fails atomically with the table unchanged.
- `references parent(col)` on the new column registers the FK with the constraint engine and is enforced on insert/update with the same MATCH SIMPLE semantics as table-level FKs.
- `default <signed-numeric-literal>` parses identically to `create table`, including negative numerics and parenthesised numeric expressions whose value is a constant literal.

## Reproduction

In `packages/quereus/test/logic/41.4-alter-add-column-constraints.sqllogic`:

- Lines 12-29 (`-- TODO bug: ALTER TABLE ADD COLUMN with column-level CHECK constraint isn't enforced on later inserts`) — `add column b ... check (b is null or b > 0)` then violating insert.
- Lines 35-56 (`-- TODO bug: ALTER TABLE ADD COLUMN with REFERENCES isn't enforced on later inserts`) — `add column parent integer null references t_parent(pid)` then violating insert.
- Lines 97-106 (`-- TODO bug: ALTER TABLE ADD COLUMN with negative-literal DEFAULT (or paren-wrapped negative) is rejected as "no DEFAULT"`) — `add column r real default -123.0`.

In `packages/quereus/test/logic/90.2.1-alter-extra-errors.sqllogic`:

- Lines 40-52 (`-- TODO bug: ALTER TABLE ADD COLUMN with column-level CHECK should validate the backfill default`) — backfill default `0` violates `check (d <> 0)`; ALTER must fail and leave the table unchanged.

Each block is commented out with a `-- TODO bug:` marker. Uncomment to reproduce.

## Likely investigation areas

- `packages/quereus/src/planner/building/alter-table.ts` — `addColumn` branch: confirm it actually attaches CHECK / FK metadata to the new `ColumnSchema` and registers them with the table's constraint set, not just storing them on the column.
- `packages/quereus/src/runtime/emit/alter-table.ts` — backfill emission path; needs to also evaluate CHECK against the backfilled rows and abort if violated.
- `packages/quereus/src/planner/building/foreign-key-builder.ts` — make sure column-level FK registration is invoked from the ADD COLUMN path, not only from CREATE TABLE.
- `packages/quereus/src/parser/parser.ts` — column-default expression parsing in the ADD COLUMN context: signed-numeric / parenthesised-literal handling probably differs from the CREATE TABLE column clause.
