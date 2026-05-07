description: DEFAULT and CHECK expressions accept non-deterministic / non-constant constructs (bind parameters, column references in DEFAULT) that should be rejected at CREATE TABLE per Quereus determinism rules.
prereq:
files:
  packages/quereus/test/logic/03.4.1-default-edge-cases.sqllogic
  packages/quereus/test/logic/40.2-check-extras.sqllogic
  packages/quereus/src/planner/building/
  docs/runtime.md
----

## Problem

`CREATE TABLE` accepts DEFAULT and CHECK expressions that violate the determinism rules documented in `docs/runtime.md#determinism-validation`. Specifically:

- **Bind parameter in DEFAULT** is accepted: `default (:xyz)` should be rejected because the DEFAULT expression must be deterministic and evaluable at row-construction time without external input.
- **Column reference in DEFAULT** is accepted: `default (x + 1)` referencing another column of the same table should be rejected — DEFAULT expressions cannot reference columns (use a generated column instead).
- **Bind parameter in CHECK** is accepted at DDL: `check (a = ?)` and `check (a = :foo)` should be rejected at CREATE TABLE because a CHECK constraint must be a deterministic predicate over the row's own values.

## Expected behavior

CREATE TABLE rejects, at DDL time, any DEFAULT or CHECK expression that is non-deterministic or references constructs outside its scope:

- DEFAULT expressions: no bind parameters, no column references, no aggregate / window / volatile function calls (the existing determinism walker should already cover the volatile cases — extend to bind params and column refs).
- CHECK expressions: no bind parameters; column references are limited to columns of the same row in the table being created/altered.

The error should be raised eagerly at parse / build time so the broken table never enters the schema.

## Reproduction

All three are commented `-- TODO bug:` blocks; uncomment to reproduce.

- `packages/quereus/test/logic/03.4.1-default-edge-cases.sqllogic:91` — `create table t_param (id integer primary key, b text default (:xyz));` is accepted.
- `packages/quereus/test/logic/03.4.1-default-edge-cases.sqllogic:99` — `create table t_colref (id integer primary key, x integer not null, y integer default (x + 1));` is accepted.
- `packages/quereus/test/logic/40.2-check-extras.sqllogic:115` — `create table t_p (a integer not null, check (a = ?));` and the `:foo` variant are accepted.

## Likely investigation areas

- DDL builder path for DEFAULT expressions (column / table builder) — add a determinism + scope-restriction pass.
- DDL builder path for CHECK expressions — extend the existing determinism walker (if any) to flag bind parameters; ensure column references are validated against the current table's columns only.
- Cross-reference `docs/runtime.md#determinism-validation` for the canonical rule set; if existing validation only runs at expression-emit time rather than DDL time, hoist it to the builder.
