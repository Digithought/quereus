description: ALTER TABLE RENAME (table or column) must rewrite references in dependent objects (CHECK, FK, views)
prereq:
files:
  packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic
  packages/quereus/src/runtime/emit/alter-table.ts
  packages/quereus/src/schema/table.ts
  packages/quereus/src/schema/view.ts
  packages/quereus/src/schema/schema.ts
  packages/quereus/src/parser/ast.ts
  packages/quereus/src/parser/visitor.ts
  packages/quereus/src/emit/ast-stringify.ts
  packages/quereus/src/planner/building/foreign-key-builder.ts
----

## Problem

`alter table ... rename to <new>` and `alter table ... rename column <old> to <new>` mutate only the directly-targeted schema entity. References held by other (or the same) schema objects are left dangling. All four sub-bugs in `41.3-alter-rename-propagation.sqllogic` were reproduced verbatim against `main`:

| # | Sub-bug | Observed failure after rename |
|---|---------|------------------------------|
| 1 | CHECK on renamed table references the table by old name (`(select count(*) from t_chk)`) | `insert into t_chk2 values (1, 10)` → `Table 't_chk' not found in schema path: main` |
| 2 | FK in another table references the renamed parent (`references parent_t(id)`) | FK enforcement silently bypassed — bad child rows accepted (count=3 instead of expected error) |
| 3 | View body has `from <old-table>` | `select * from vv` → `Table 'tv_src' not found in schema path: main` |
| 4 | View body projects/filters renamed column | `select * from v_vc` → `Column not found: old_n` |

Underlying causes:
- `runRenameTable` in `runtime/emit/alter-table.ts:60` updates only the renamed `TableSchema` (and the module's storage key) — it never walks other schema objects.
- `runRenameColumn` (`alter-table.ts:105`) updates only the column array of the target table — no rewrite of dependents.
- The schema layer has no dependency tracker; views (`ViewSchema.selectAst` + `sql`), CHECK constraints (`RowConstraintSchema.expr`), and FK records (`ForeignKeyConstraintSchema.referencedTable` + `referencedColumnNames`) all hold the old names verbatim.
- Views are re-resolved against the live schema on every read (see `planner/building/select.ts:340` invoking `buildSelectStmt(viewSchema.selectAst)`), so once we mutate the stored AST the next read transparently picks up the new names. FK records resolve `referencedTable` dynamically at enforcement time (`planner/building/foreign-key-builder.ts:141`), so updating the field is sufficient — no re-binding needed.

## Approach

Add a small AST-rewrite module and call it from the rename runtime to update every dependent schema object in the affected schema. Two operations:

1. **rename table** (`oldName → newName` in schema `S`):
   - Walk every `TableSchema` in `S`:
     - Rewrite `checkConstraints[*].expr` (and the renamed table's own checks) replacing references to `oldName`.
     - Rewrite `foreignKeys[*].referencedTable` (and where applicable `referencedSchema`).
   - Walk every `ViewSchema` in `S`:
     - Rewrite `selectAst` replacing references to `oldName`.
     - Rebuild `sql` via `selectToString` so introspection / catalog export stay consistent.

2. **rename column** (`tableName.oldCol → tableName.newCol` in schema `S`):
   - Walk every `TableSchema` in `S`:
     - Rewrite `checkConstraints[*].expr` replacing column refs to `tableName.oldCol`.
     - Rewrite `foreignKeys[*]` whose `referencedTable === tableName` and whose `referencedColumnNames` contain `oldCol`.
   - Walk every `ViewSchema` in `S`: rewrite `selectAst` and rebuild `sql`.

Notifications: emit `table_modified` / corresponding catalog change events for every affected dependent so listeners (sync, indexes, caches) see the propagation.

### AST-rewrite module: `src/schema/rename-rewriter.ts` (new)

Provides two pure-ish helpers that walk an AST in place and return whether they changed anything (useful so the caller can skip Object-frozen re-clones when nothing matched):

```ts
// Returns true if any rewrite was applied.
export function renameTableInAst(
  node: AST.AstNode | undefined,
  oldName: string,
  newName: string,
  defaultSchemaName: string,        // schema of the renamed table
): boolean;

export function renameColumnInAst(
  node: AST.AstNode | undefined,
  tableName: string,                // table whose column is renamed
  oldColName: string,
  newColName: string,
  defaultSchemaName: string,
): boolean;
```

Both walkers traverse the same node types as `traverseAst` in `parser/visitor.ts`. Two reasons to write a new walker rather than re-using the existing one: (a) it must mutate, not just observe; (b) `renameColumnInAst` needs FROM-clause scope tracking that the read-only visitor doesn't expose.

#### Match rules — `renameTableInAst`

Case-insensitive name comparison throughout (Quereus catalog is case-insensitive).
- `TableSource` (`from foo`): if `node.table.name === oldName` AND (`node.table.schema === undefined` OR `node.table.schema === defaultSchemaName`), rewrite `node.table.name = newName`.
- `ColumnExpr` and `IdentifierExpr`: if `node.table === oldName` (the qualifier), rewrite to `newName`.
- `InsertStmt.table`, `UpdateStmt.table`, `DeleteStmt.table` (typed `IdentifierExpr`): same rule. (Views' bodies are SELECTs so this applies to mutating subqueries inside views and to assertion bodies.)
- Recurse into joins, subqueries, CTEs, CASE, IN, EXISTS, BETWEEN, function args, window definitions.

Aliases: do NOT rewrite alias text, only the underlying table name. A `from <oldName> as a` becomes `from <newName> as a`; references to `a.col` are left alone.

#### Match rules — `renameColumnInAst`

Walk maintains a stack of "in-scope FROM tables (unaliased)" while recursing.
- On entering a `SelectStmt` or any clause that introduces a new FROM scope, compute the set of (schema, table) pairs visible without an alias. A `TableSource` with no alias contributes its `(schema ?? defaultSchemaName, table.name)`. A `TableSource` WITH an alias contributes only the alias→underlying mapping; it does not put the underlying name into the unqualified-resolution set.
- For `ColumnExpr` qualified by `table`:
  - If the qualifier is the renamed `tableName` (or an alias whose underlying table is `tableName`) AND `name === oldColName`, rewrite `name = newColName`.
- For `ColumnExpr` with no qualifier:
  - If the current scope's unqualified-resolution set contains `tableName` (`(defaultSchemaName, tableName)`), rewrite when `name === oldColName`. Best-effort: if multiple in-scope tables expose a column with the old name we cannot know without re-binding, but we always rewrite anyway — a name conflict would have been ambiguous before the rename and still is after.
- Special note on `select * from t` style stars: these are stored as `ResultColumn` of `type === 'all'` and don't contain the column name, so nothing to rewrite. The view re-binds against the renamed schema so `*` will pick up the new column name automatically.

Recurse into nested SELECTs (subqueries, CTEs, EXISTS, IN-subquery), pushing/popping the scope stack as appropriate.

### Integration points in `src/runtime/emit/alter-table.ts`

After the existing `runRenameTable` body successfully swaps the renamed table:

```ts
await propagateTableRename(rctx, schema, oldName, newName);
```

`propagateTableRename(rctx, schema, oldName, newName)`:
- Iterate `schema.getAllTables()`. For each table:
  - For each CHECK constraint, walk `expr`. If anything changed, build a new `RowConstraintSchema` and replace the constraint in a new (frozen) `checkConstraints` array.
  - For each FK, if `(fk.referencedSchema ?? schema.name).toLowerCase() === schema.name.toLowerCase()` AND `fk.referencedTable.toLowerCase() === oldName.toLowerCase()`, build a new FK with `referencedTable: newName`.
  - If any change, write a new `TableSchema` (copy with `Object.freeze`) and `schema.addTable(...)`. Emit `table_modified`.
- Iterate `schema.getAllViews()`. For each view:
  - Walk `view.selectAst`. If anything changed, rebuild `view.sql` via `selectToString(view.selectAst)`.
  - `schema.addView({ ...view, sql: newSql })` (selectAst already mutated in place, but we replace the wrapper to make the change observable).
  - Emit a view event if/when the change-event union grows view types — for now, no view events exist (`SchemaChangeEvent` in `src/schema/change-events.ts` only covers tables/functions/modules/collations); we just update the schema. Add a TODO note tying view events to a separate ticket.

Mirror for `runRenameColumn`:

`propagateColumnRename(rctx, schema, tableName, oldCol, newCol)`:
- Iterate tables: rewrite CHECK exprs as above (column-level rewrite). Also rewrite any FK whose `referencedTable === tableName` and whose `referencedColumnNames` contains `oldCol` — replace that entry with `newCol`. Note that `columns: ReadonlyArray<number>` (child-side indices) does not change since we're renaming a column on the parent side; on the child side, child indices stay the same since `runRenameColumn` already updated the child table's `columnIndexMap` correctly when *its own* column was renamed.
- Iterate views: rewrite `selectAst`, rebuild `sql`.

### Schema mutability

`TableSchema` is `Object.freeze`'d at creation time. Use spread-copy with a frozen result and call `schema.addTable(updated)` — this is the same idiom already used by `runAddColumn`, `runDropColumn`, etc. in `alter-table.ts`.

`ViewSchema` is not frozen and is stored as a plain object. We can mutate `selectAst` in place (the planner re-walks it on every reference and produces fresh PlanNodes) and update `sql`. Re-calling `schema.addView(view)` (which is idempotent map-set) keeps the schema-events path consistent.

### Edge cases & non-goals

- Self-referential CHECK on renamed table — covered (we walk *every* table, including the just-renamed one).
- FK self-references (a table whose FK points to itself, then it's renamed) — covered (same loop).
- Aliases inside CHECK / view subqueries — preserved.
- Cross-schema FK references — `propagateTableRename` only walks the schema we renamed in (parent table's schema). FKs from other schemas to this table also need updating; iterate all schemas via `schemaManager._getAllSchemas()` and check FK `referencedSchema` matches the renamed table's schema. Keep the table loop scoped per-schema-encountered.
- Indices: `IndexSchema.columns` references column indices, not names, so column rename is automatically reflected. Partial-index `where` clauses are stored as `Expression` AST — handled by reusing `renameColumnInAst` over `tableSchema.indexes[*].where` if/when partial-index expressions are stored on the schema. (Currently they're parsed but not retained in `IndexSchema` per `schema/table.ts:213-226`; not a regression — partial-index test in section 2 of the sqllogic file already passes against `main` because the WHERE is held by the module/manager directly. Skip in this ticket.)
- CTE-in-view (sqllogic case 6) — explicitly excluded (parser doesn't accept `create view ... as with ...`); handled by sibling ticket `1-fix-view-validation-and-cte-edge-cases`.
- Renaming across schema boundaries (`alter table main.foo rename to bar`) — out of scope; existing rename only acts within one schema.

### Observable behavior after fix

- Insert into renamed table whose CHECK references itself by old name → succeeds; CHECK now sees the new table name and resolves.
- FK enforcement on a child table whose parent was renamed → continues to validate; bad inserts fail, valid inserts succeed.
- `select * from v` where `v` was built on the renamed table → returns rows from the new table.
- `select * from v` where `v` projected a renamed column → returns rows with the new column name in the result schema (the existing view re-binding path takes care of the result-column metadata; we only need the AST to no longer reference the old name).

## TODO

Phase 1 — AST rewriter

- Create `packages/quereus/src/schema/rename-rewriter.ts` exporting `renameTableInAst` and `renameColumnInAst`.
- Implement table-rename walker covering: SelectStmt, InsertStmt, UpdateStmt, DeleteStmt, ValuesStmt, all FromClause variants (including JoinClause, SubquerySource, MutatingSubquerySource, FunctionSource), all Expression variants (BinaryExpr, UnaryExpr, FunctionExpr, CastExpr, SubqueryExpr, ColumnExpr, IdentifierExpr, CollateExpr, CaseExpr, InExpr, ExistsExpr, BetweenExpr, WindowFunctionExpr, WindowDefinition).
- Implement column-rename walker with FROM-clause scope tracking. Treat aliases via a per-SELECT alias→table map; keep a stack so nested SELECTs restore the parent scope on exit.
- Both helpers return a boolean `changed` flag for cheap "no-op" detection.

Phase 2 — Wire into runtime

- In `src/runtime/emit/alter-table.ts`:
  - After `runRenameTable` swaps the table in the catalog, call `propagateTableRename(rctx, schema, oldName, newName)`. Walk every table and view in the schema and apply rewrites; rebuild any that changed via the existing spread-and-`addTable` pattern. Also walk *other* schemas' tables to catch cross-schema FK references whose `referencedSchema` matches the renamed table's schema.
  - After `runRenameColumn` updates the target table's column array, call `propagateColumnRename(rctx, schema, tableName, oldCol, newCol)`. Same pattern.
- Emit `table_modified` notifications for each dependent table whose schema changed; rely on view re-resolution for views (no view event type exists yet — leave a TODO comment if/when a view-change event is added).

Phase 3 — Tests & docs

- Uncomment all four blocks (cases 1, 2, 3, 4) in `packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic`. Remove the `-- TODO bug:` markers. Leave case 6 (CTE-in-view) commented since it depends on the separate parser fix.
- Add a few targeted regressions to the same file:
  - **Aliased renamed table in view**: `create view va as select x.id from tv_src as x; alter table tv_src rename to tv_src2; select * from va;` — should still work, alias preserved.
  - **Cross-schema FK** (if a `temp.child` references `main.parent`): rename `main.parent` and verify `temp.child` FK still enforces.
  - **CHECK in another table referencing a third table by name** (less common but worth a smoke: `create table a (id int); create table b (id int check ((select count(*) from a) >= 0)); alter table a rename to a2; insert into b values (1);` — should succeed).
  - **Column rename used in another table's CHECK**: `create table p (id int, k int); create table c (id int check ((select count(*) from p where p.k > 0) >= 0)); alter table p rename column k to kk; insert into c values (1);` — should succeed.
- Run `yarn test` from the repo root; expect the previously-skipped cases to pass and no other regression.
- Run `yarn lint` in `packages/quereus`.
- Update `docs/sql.md` (or wherever ALTER TABLE is documented) with a brief note that rename propagation now covers CHECK, FK, and view bodies. Cross-reference the dependency-tracking design (none yet — implementation is best-effort AST rewrite).

Phase 4 — Hardening (optional, only if time allows)

- Consider running the full `yarn test:store` once to make sure the LevelDB-backed path still works under the new rewrite. (Storage modules don't see the AST rewrites — only the catalog mutations propagate.)
