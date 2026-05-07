description: Review per-table generated-column dependency graph — chained gen→gen INSERT/UPDATE evaluation in topological order, cycle/self-edge detection at CREATE TABLE / ALTER TABLE ADD COLUMN, DROP COLUMN of a column referenced by a generated column blocked.
prereq:
files:
  packages/quereus/src/schema/table.ts
  packages/quereus/src/schema/manager.ts
  packages/quereus/src/planner/building/insert.ts
  packages/quereus/src/planner/building/update.ts
  packages/quereus/src/runtime/emit/alter-table.ts
  packages/quereus/test/logic/41-generated-column-extras.sqllogic
  packages/quereus/test/logic/41-generated-column-errors.sqllogic
----

## Summary of changes

### Per-table dependency graph (`schema/table.ts`)
- `TableSchema` extended with two optional fields:
  - `generatedColumnDependencies?: ReadonlyMap<number, ReadonlyArray<number>>` — for each generated-column index, the set of column indices in this table its expression reads.
  - `generatedColumnTopoOrder?: ReadonlyArray<number>` — generated-column indices ordered so deps come before dependents.
- `extractGeneratedColumnDependencies(columns, tableName)` walks each generated column's `generatedExpr` AST via `traverseAst`. For every `ColumnExpr` (and `IdentifierExpr` without a foreign schema qualifier) it looks up the name in the table's column-index map. References qualified to a different table are skipped. Unknown column names referenced unqualified (or qualified to this table) raise `QuereusError("Column 'X' referenced by generated column 'Y' not found …")` so typos surface at DDL time rather than at INSERT/UPDATE time.
- `topoSortGeneratedColumns(columns, deps)` runs Kahn's algorithm restricted to gen→gen edges. Self-edges (`a generated as (a + 1)`) and cycles (`c1 → c2 → c1`) raise `QuereusError("Cyclic dependency in generated columns: …")`. Tie-break on declaration order for determinism.
- `withGeneratedColumnGraph(tableSchema)` recomputes both fields from the current column array — used after ALTER TABLE so column-index shifts are picked up.

### CREATE TABLE wiring (`schema/manager.ts`)
- `buildTableSchemaFromAST` now invokes `extractGeneratedColumnDependencies` and `topoSortGeneratedColumns`, freezing the resulting map and order onto the returned `TableSchema`. Cycle detection runs *before* `module.create`, so an invalid schema never reaches storage. Non-existent gen-column refs are caught here too.

### ALTER TABLE wiring (`runtime/emit/alter-table.ts`)
- `runAddColumn`: after merging the new column-level CHECK / FK into the module-returned schema, the dep graph is rebuilt with `withGeneratedColumnGraph`. If the added column is generated and its expression references an unknown column, or any new gen→gen edges form a cycle, this throws *before* the catalog is mutated.
- `runDropColumn`: scans `tableSchema.generatedColumnDependencies` first. If any *other* generated column's deps include the target column index, throws `QuereusError(StatusCode.CONSTRAINT, "Cannot drop column 'x' from 't': it is referenced by generated column 'g'")`. Dropping a generated column itself is allowed; its outgoing edges disappear with it. After `module.alterTable` returns the post-drop schema, the dep graph is re-extracted (old indices are stale once a column is removed) before re-registering with the catalog.

### INSERT planner (`planner/building/insert.ts`)
- `createGeneratedColumnProjection` rewritten as a chain of one-projection-per-gen-column folded in `generatedColumnTopoOrder`. Each iteration:
  1. Builds a fresh `RegisteredScope` over the current node's attributes — every column (including any already-computed generated columns from earlier iterations) resolves to its current attribute.
  2. Constructs N projections: pass-through `ColumnReferenceNode`s for every column except the gen-column-of-the-iteration, which is built from `generatedExpr` in the new scope and validated for determinism.
- The "Generated columns can't be referenced by other generated columns" comment / restriction in `createGeneratedColumnProjection` is removed.
- The fast path (no generated columns) is preserved by the empty `topoOrder` check.

### UPDATE planner (`planner/building/update.ts`)
- `buildUpdateStmt` iterates `generatedColumnTopoOrder` instead of `tableSchema.columns` when appending implicit generated assignments. The runtime emitter (`runtime/emit/update.ts`) already evaluates generated assignments against the in-place `updatedRow` via `withRowContext`, so iterating in topological order is enough — by the time `w = m * 5` evaluates, `m`'s slot in `updatedRow` already holds the freshly-computed value.

## Test plan

- Uncomment the four reproduction blocks called out in the source ticket and confirm they pass:
  - `test/logic/41-generated-column-extras.sqllogic`: chained `m = a*2`, `w = m*5` — INSERT/SELECT/UPDATE/SELECT.
  - `test/logic/41-generated-column-errors.sqllogic`: self-referencing column rejected at CREATE TABLE.
  - `test/logic/41-generated-column-errors.sqllogic`: mutually-recursive `c1`/`c2` rejected at CREATE TABLE.
  - `test/logic/41-generated-column-errors.sqllogic`: DROP COLUMN of `a` fails when `b generated as (a*2)` exists; dropping `b` itself succeeds; surviving SELECT shows `id`, `a`.
- Added a reverse-declaration-order chain block (`t_chain_rev`: `w` declared *before* its dependency `m`) to exercise the topo-sort path on the INSERT side; would fail with declaration-order processing.

## Validation

- `yarn test` (in `packages/quereus`): 2522 passing, 3 pending (unchanged).
- `yarn lint` (in `packages/quereus`): clean.
- `tsc --noEmit`: clean.
- `yarn test:store` not run — no MemoryTable-specific or store-specific code paths were touched. (DROP COLUMN goes through `module.alterTable` either way; the dep-graph recompute happens after, on the returned schema.)

## Things to look at in review

- The "skip subqueries" question. `extractGeneratedColumnDependencies` walks the entire AST including subqueries. A scalar subquery referencing this table's column qualified by name (`(select max(x) from u where u.k = a)`) would, today, treat `a` as a same-table dep — correct. An unqualified reference inside the subquery to the subquery's own table source might also resolve to a same-named column in this table and over-report a dependency. In practice this is benign: over-reporting can only over-trigger topo edges (never miss them), and `validateDeterministicGenerated` already rejects scalar subqueries in generated expressions because they're non-deterministic. Worth confirming the determinism guard still fires for subqueries; if so, the subquery-walking question is moot.
- The "module returns its own schema" path in `finalizeCreatedTableSchema`: today the memory module preserves the schema reference, so the deps map carries through. If a future module rebuilds the schema, the deps would be lost; we'd need a `withGeneratedColumnGraph` call there too. Not a behaviour bug today — flagged for future-proofing.
- The error code. Cycle / unknown-ref / self-edge raise `StatusCode.ERROR`; DROP COLUMN refusal raises `StatusCode.CONSTRAINT`. The drop case feels constraint-y (DDL refusing because of a graph edge); the create-table cases feel more like "bad SQL" (can't be a valid schema), so `ERROR` matches existing CHECK/DEFAULT validators in `manager.ts`. Reviewers should sanity-check the codes against any catalog-level expectations.

## Usage examples

```sql
-- Chained generated columns now work in declaration order:
create table t (
  id integer primary key,
  a integer not null,
  m integer generated always as (a * 2) stored,
  w integer generated always as (m * 5) stored
);
insert into t (id, a) values (1, 3);
-- a=3, m=6, w=30
update t set a = 4 where id = 1;
-- a=4, m=8, w=40

-- …and in reverse declaration order (topo sort handles it):
create table t_rev (
  id integer primary key,
  a integer not null,
  w integer generated always as (m * 5) stored,
  m integer generated always as (a * 2) stored
);

-- Cycles / self-edges rejected at CREATE TABLE:
create table t_self (id integer primary key, a integer generated always as (a + 1) stored);
-- error: Cyclic dependency in generated columns: 'a'

-- DROP COLUMN guards against breaking a referencing gen column:
create table t (id integer primary key, a integer not null, b integer generated always as (a * 2) stored);
alter table t drop column a;
-- error: Cannot drop column 'a' from 't': it is referenced by generated column 'b'
alter table t drop column b;  -- ok
```
