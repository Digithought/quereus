description: Add per-table generated-column dependency graph; cycle-check at CREATE TABLE, topo-order evaluation in INSERT/UPDATE, block DROP COLUMN of referenced columns.
prereq:
files:
  packages/quereus/src/schema/column.ts
  packages/quereus/src/schema/table.ts
  packages/quereus/src/schema/manager.ts
  packages/quereus/src/planner/building/insert.ts
  packages/quereus/src/planner/building/update.ts
  packages/quereus/src/runtime/emit/update.ts
  packages/quereus/src/runtime/emit/alter-table.ts
  packages/quereus/src/parser/visitor.ts
  packages/quereus/test/logic/41-generated-column-extras.sqllogic
  packages/quereus/test/logic/41-generated-column-errors.sqllogic
----

## Summary

All four sub-bugs in the source ticket share one missing primitive: a per-table
dependency graph from each generated column to the columns its expression
reads. With the graph in place:

- chained generated columns (`m = a*2`, `w = m*5`) evaluate in topological
  order — currently the INSERT planner explicitly excludes generated columns
  from the gen-column scope (`packages/quereus/src/planner/building/insert.ts:172`,
  comment "Generated columns can't be referenced by other generated columns")
  and the reference fails with "Column not found: m";
- self-referencing (`a = a + 1`) and mutually-recursive generated columns are
  rejected at CREATE TABLE because the graph contains a cycle;
- `ALTER TABLE … DROP COLUMN x` fails when `x` has incoming edges from any
  generated column.

UPDATE already evaluates generated assignments against the freshly-mutated
`updatedRow` (see `packages/quereus/src/runtime/emit/update.ts:56-67`) and the
build-time scope (`packages/quereus/src/planner/building/update.ts:74-82`)
registers every column including generated ones, so chains work for UPDATE
**only when generated columns are added to the assignment list in topological
order**. Today they are pushed in declaration order
(`packages/quereus/src/planner/building/update.ts:107-115`). Switching that
ordering to topological is the only UPDATE-side fix needed.

INSERT needs more: the second projection in
`createGeneratedColumnProjection` (`packages/quereus/src/planner/building/insert.ts:161-208`)
must let each generated column resolve names to previously-computed generated
columns. A clean way is to chain N projections, one per generated column in
topological order; each projection passes through every column and recomputes
exactly one generated column whose expression resolves names against the
prior projection's attributes (which by then include freshly-computed earlier
gen columns).

## Design

### 1. Dependency extraction

New helper, `extractGeneratedColumnDependencies(columns)`, returns
`Map<number /* gen col index */, ReadonlyArray<number /* dep col index */>>`.

For each `col` where `col.generated && col.generatedExpr`:

- Walk `col.generatedExpr` with `traverseAst`
  (`packages/quereus/src/parser/visitor.ts`).
- For every `ColumnExpr` (`type === 'column'`) and `IdentifierExpr`
  (`type === 'identifier'`) that lacks a foreign `schema`/`table` qualifier
  pointing elsewhere, look up `name.toLowerCase()` in the table's
  `columnIndexMap`. Skip references qualified to a *different* table; an
  unqualified reference or one qualified to this table contributes an edge.
- Bind parameters, literals, scalar subqueries, and function calls do not
  contribute edges. Scalar subqueries that reference outer columns of the same
  table do contribute (use the existing `traverseAst` recursion which already
  walks subqueries).
- Unknown column names raise `QuereusError` with a clear "Column 'X'
  referenced by generated column 'Y' not found" — this catches typos that
  today silently slip through and surface only at INSERT/UPDATE time.

Place in `packages/quereus/src/schema/table.ts` (alongside the existing
`findPKDefinition` / `buildColumnIndexMap` helpers) so the dependency
extraction stays close to where the column schemas are assembled.

### 2. Cycle detection + topological sort

New helper, `topoSortGeneratedColumns(deps)`, also in
`packages/quereus/src/schema/table.ts`:

- Restrict to gen→gen edges (a gen column depending on a non-gen column does
  not create a node in the gen subgraph).
- Standard Kahn or DFS topo sort over gen-column nodes.
- On any back edge or self-edge, throw
  `QuereusError("Cyclic dependency in generated columns: <names>", StatusCode.ERROR)`.
- Returns `ReadonlyArray<number>`: the gen-column indices in dependency order
  (deps before dependents).

Self-edges (`a generated as (a + 1)`) are caught the same way — `a`'s
adjacency list contains `a`, which is detected as a back edge.

### 3. Where to surface the topo order

Add two optional fields on `TableSchema`
(`packages/quereus/src/schema/table.ts`):

```ts
/** For each generated column index, the column indices its expression reads. */
generatedColumnDependencies?: ReadonlyMap<number, ReadonlyArray<number>>;
/** Generated column indices ordered so dependencies come before dependents. */
generatedColumnTopoOrder?: ReadonlyArray<number>;
```

Compute both in `SchemaManager.buildTableSchemaFromAST` (or `buildColumnSchemas`
— wherever the final column array is assembled) and freeze them onto the
schema returned to the module. This avoids re-walking AST on every
INSERT/UPDATE plan.

### 4. CREATE TABLE cycle check

In `SchemaManager.createTable`
(`packages/quereus/src/schema/manager.ts:1177`), call the new helpers
alongside the existing `validateDefaultDeterminism` /
`validateCheckConstraintDeterminism` calls (around line 1211). Cycle
detection happens before `module.create`, so an invalid schema never reaches
storage.

ALTER TABLE ADD COLUMN must also re-run cycle detection if the new column is
generated — `runAddColumn` in `packages/quereus/src/runtime/emit/alter-table.ts`.

### 5. INSERT — chained generated columns

Rewrite `createGeneratedColumnProjection`
(`packages/quereus/src/planner/building/insert.ts:161-208`) to fold one
generated column at a time, in topological order:

```
expandedSource (with NULL placeholders for gen cols)
  → projectionForGen[topo[0]]   (recompute topo[0]; pass through everything else)
  → projectionForGen[topo[1]]   (recompute topo[1]; pass through everything else,
                                  including the freshly-computed topo[0])
  → …
```

Each per-gen-column projection builds a `RegisteredScope` over the prior
node's attributes (every column of the prior projection, including any
already-computed generated columns), then builds the gen expression in that
scope. Non-generated columns and not-yet-processed generated columns pass
through via `ColumnReferenceNode`.

Drop the comment / early-return that excludes generated columns from the
scope at `packages/quereus/src/planner/building/insert.ts:172`. The new
chained design replaces it.

If the table has no generated columns the existing fast path is preserved.

### 6. UPDATE — order generated assignments topologically

In `buildUpdateStmt`
(`packages/quereus/src/planner/building/update.ts:107-115`), iterate
`tableSchema.generatedColumnTopoOrder` instead of `tableSchema.columns` when
appending generated assignments. Runtime emitter
(`packages/quereus/src/runtime/emit/update.ts`) needs no change — it already
evaluates each gen assignment against the in-place `updatedRow` and the
expressions resolve column names against the source row descriptor that's
been bound to `updatedRow` via `withRowContext`.

### 7. ALTER TABLE DROP COLUMN — block dependency-violating drops

In `runDropColumn`
(`packages/quereus/src/runtime/emit/alter-table.ts:341`), after the existing
PK / last-column guards, scan `tableSchema.generatedColumnDependencies`. If
any gen column's deps include the target column index, raise:

```
QuereusError(
  `Cannot drop column '<col>' from '<table>': it is referenced by ` +
  `generated column '<gen>'`,
  StatusCode.CONSTRAINT,
)
```

Dropping a generated column is allowed; its outgoing edges disappear with it.
The schema is rebuilt by `module.alterTable`, after which the dependency map
must be recomputed for the returned schema (otherwise the stale map keeps
referencing the deleted column index). Easiest: recompute via the new helper
right before re-registering the schema in the catalog.

## Test plan

Uncomment the four blocks called out by the source ticket and confirm they
pass:

- `packages/quereus/test/logic/41-generated-column-extras.sqllogic` lines
  8-26 — chained `m = a*2`, `w = m*5`; INSERT, SELECT, UPDATE, SELECT.
- `packages/quereus/test/logic/41-generated-column-errors.sqllogic` lines
  8-14 — self-referencing column rejected at CREATE TABLE.
- `packages/quereus/test/logic/41-generated-column-errors.sqllogic` lines
  20-28 — mutually-recursive columns rejected at CREATE TABLE.
- `packages/quereus/test/logic/41-generated-column-errors.sqllogic` lines
  34-53 — DROP COLUMN of `a` fails; DROP COLUMN of generated `b` succeeds;
  follow-up SELECT shows `id`, `a` survive.

Add coverage for one extra case worth nailing down explicitly: a
**reverse-declaration-order chain** in INSERT — declare `w` (depending on
`m`) before `m`, exercising the topo-sort path in INSERT planning. Today this
would also fail with declaration-order processing; add a small block to
`41-generated-column-extras.sqllogic` and verify the topo sort lets it
through.

Run `yarn lint` (quereus only) and `yarn test`. `yarn test:store` is not
required for this fix unless DROP COLUMN behaviour appears to differ on the
LevelDB path.

## TODO

- Add `extractGeneratedColumnDependencies` and `topoSortGeneratedColumns`
  helpers in `packages/quereus/src/schema/table.ts`. Reject unknown column
  references inside generated expressions.
- Extend `TableSchema` with `generatedColumnDependencies` and
  `generatedColumnTopoOrder` fields; populate them in
  `SchemaManager.buildTableSchemaFromAST` (or wherever the final
  `TableSchema` is assembled before module.create).
- In `SchemaManager.createTable`, after schema build but before
  `module.create`, run the cycle check and raise on cycle / self-edge.
- In `runAddColumn` (alter-table emitter), re-run dependency extraction and
  cycle check when the added column is generated; reject on cycle.
- Refactor `createGeneratedColumnProjection` in
  `packages/quereus/src/planner/building/insert.ts` to chain per-gen-column
  projections in `generatedColumnTopoOrder`, dropping the
  generated-cols-can't-reference-each-other restriction.
- In `buildUpdateStmt`, iterate `generatedColumnTopoOrder` when pushing
  implicit generated assignments.
- In `runDropColumn` (alter-table emitter), reject when the target column
  has incoming edges in `generatedColumnDependencies`. Recompute the
  dependency map / topo order on the rebuilt schema before re-registering it.
- Uncomment the four reproduction blocks in the two sqllogic files; add a
  reverse-declaration-order chain block to confirm topo-sort coverage.
- Confirm `yarn lint` (quereus) and `yarn test` are green.
