description: Generated columns lack dependency analysis — chained refs fail, self/mutual recursion not rejected, dependency-blocked DROP COLUMN allowed
prereq:
files:
  packages/quereus/test/logic/41-generated-column-extras.sqllogic
  packages/quereus/test/logic/41-generated-column-errors.sqllogic
  packages/quereus/src/schema/column.ts
  packages/quereus/src/schema/table.ts
  packages/quereus/src/planner/building/insert.ts
  packages/quereus/src/planner/building/update.ts
  packages/quereus/src/planner/building/alter-table.ts
  packages/quereus/src/runtime/emit/update.ts
----

## Problem

Generated columns are evaluated without a proper dependency graph between columns. This produces both false negatives (valid chains rejected) and false positives (invalid definitions and dependency-violating ALTERs accepted):

- **Generated column referencing another generated column** fails with "Column not found". A column whose expression refers to another `generated always as (...)` column in the same table cannot resolve the reference, even though the referenced column's value is fully determined and could be evaluated first if the engine ordered evaluation by dependency.
- **Self-referencing generated column** (`a integer generated always as (a + 1) stored`) is silently accepted at CREATE TABLE; should be rejected because the expression is its own dependency.
- **Mutually-recursive generated columns** (`c1 = c0 + c2`, `c2 = c1`) are silently accepted at CREATE TABLE; should be rejected because the dependency graph contains a cycle.
- **DROP COLUMN of a column referenced by a GENERATED expression** is silently accepted; should be rejected because it would leave the generated column with an unresolvable expression.

All four sub-bugs share the same missing primitive: a per-table dependency graph from each generated column to the columns its expression reads. With that graph in place: chained evaluation becomes a topological-order pass, self/mutual recursion is a cycle check at CREATE TABLE, and DROP COLUMN consults the graph for incoming edges.

## Expected behavior

- At CREATE TABLE, the engine builds the per-column dependency graph for generated columns. If the graph contains any cycle (including self-edges), CREATE TABLE fails.
- INSERT/UPDATE evaluates generated columns in topological order so a generated column whose expression names another generated column resolves correctly.
- ALTER TABLE DROP COLUMN of a column that has incoming edges in the generated-column graph fails; dropping a generated column itself succeeds and removes its outgoing edges.

## Reproduction

In `packages/quereus/test/logic/41-generated-column-extras.sqllogic`:

- Lines 8-26 (`-- TODO bug: generated column referencing another generated column not supported (Column not found: m)`) — `m` is `generated as (a*2)`, `w` is `generated as (m*5)`; insert and select both `m` and `w`.

In `packages/quereus/test/logic/41-generated-column-errors.sqllogic`:

- Lines 8-14 (`-- TODO bug: self-referencing generated column should be rejected at CREATE TABLE`).
- Lines 20-28 (`-- TODO bug: mutually-recursive generated columns should be rejected at CREATE TABLE`).
- Lines 34-53 (`-- TODO bug: DROP COLUMN of a column referenced by a generated column should be rejected`).

All blocks are commented out with `-- TODO bug:` markers. Uncomment to reproduce.

## Likely investigation areas

- `packages/quereus/src/schema/column.ts` and `packages/quereus/src/schema/table.ts` — where generated-column metadata is stored; needs a per-table dependency graph (or per-column "depends on these columns" set) computed from the parsed expression.
- CREATE TABLE build path that finalises the table schema — cycle check belongs here.
- `packages/quereus/src/planner/building/insert.ts`, `packages/quereus/src/planner/building/update.ts`, `packages/quereus/src/runtime/emit/update.ts` — generated-column evaluation; must topo-sort generated columns rather than processing in declaration order, so a generated column can read another generated column's freshly-computed value.
- `packages/quereus/src/planner/building/alter-table.ts` — DROP COLUMN branch: consult the generated-column dependency graph and reject if the target has any incoming edge from a generated column.
