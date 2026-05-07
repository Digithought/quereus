description: ALTER TABLE RENAME (table or column) now rewrites references in dependent objects (CHECK, FK, views)
prereq:
files:
  packages/quereus/src/schema/rename-rewriter.ts
  packages/quereus/src/runtime/emit/alter-table.ts
  packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic
  docs/sql.md
----

## Summary

`alter table ... rename to <new>` and `alter table ... rename column <old> to <new>` previously mutated only the directly-targeted schema entity. Dependent objects — CHECK expressions, FOREIGN KEY references, and view bodies — kept the old name and broke at the next read or write. They are now propagated automatically.

## Behavior

Now correct after rename:

```sql
-- CHECK on a renamed table that self-references gets rewritten:
create table t_chk (id integer primary key, v integer not null);
alter table t_chk add constraint c1 check ((select count(*) from t_chk) >= 0);
alter table t_chk rename to t_chk2;
insert into t_chk2 values (1, 10);          -- works; CHECK now references t_chk2

-- FK in another table is still enforced under the new parent name:
create table parent_t (id integer primary key);
create table child_t (id integer primary key,
                     pid integer not null references parent_t(id) on delete restrict on update restrict);
alter table parent_t rename to parent_t2;
insert into child_t values (11, 99);         -- FK violation
insert into child_t values (12, 1);          -- ok

-- View bodies follow the rename:
create view vv as select id, name from tv_src;
alter table tv_src rename to tv_src2;
select * from vv;                             -- works; view body now references tv_src2

-- Column rename rewrites projection / WHERE inside views:
create view v_vc as select id, old_n from t_vc where old_n is not null;
alter table t_vc rename column old_n to new_n;
select * from v_vc;                           -- result column is `new_n`
```

## Implementation

`packages/quereus/src/schema/rename-rewriter.ts` exports two AST walkers:

- `renameTableInAst(node, oldName, newName, defaultSchemaName)` — mutates table-source names, column qualifiers, and Insert/Update/Delete `.table` identifiers in place. Returns whether anything changed.
- `renameColumnInAst(node, tableName, oldColName, newColName, defaultSchemaName)` — mutates column references that resolve to `tableName.oldColName`. Tracks a per-SELECT FROM scope so unqualified column references are only rewritten when the renamed table is in the unaliased FROM list (and qualified references via aliases are resolved through an alias→underlying-table map). Also rewrites Insert/Update assignments and Upsert conflict targets when the target table is the renamed table.

Name comparisons are case-insensitive throughout; aliases preserve their text.

`packages/quereus/src/runtime/emit/alter-table.ts` wires propagation in:

- After `runRenameTable` swaps the renamed table in the catalog, `propagateTableRename` walks every schema. For each table it rewrites CHECK exprs (in place) and FK `referencedTable` entries (creating a new frozen `TableSchema` only when something changed and re-installing it via `schema.addTable`), emitting `table_modified` events for each touched table. For each view in the home schema it rewrites `selectAst` in place and rebuilds `view.sql` via `selectToString`.
- `runRenameColumn` calls `propagateColumnRename` symmetrically. Cross-schema FK `referencedColumnNames` are rewritten when the FK targets the renamed table's schema and table.

The runtime mutates AST nodes in place rather than deep-cloning. Constraints are wholly replaced with new `RowConstraintSchema` objects and FKs with new `ForeignKeyConstraintSchema` objects, and the new `TableSchema` is `Object.freeze`'d before re-installation.

The planner's existing FK-enforcement pipeline already resolves `fk.referencedTable` at plan time (`packages/quereus/src/planner/building/foreign-key-builder.ts`), so simply updating that field is enough for fresh INSERT/UPDATE plans to bind to the renamed parent. Views are re-resolved on every read via `buildSelectStmt(viewSchema.selectAst)`, so mutating `selectAst` is enough for new readers to see the rewritten body.

## Tests

`packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic` is now active. Cases covered:

1. CHECK on a self-referencing renamed table.
2. Partial-index WHERE survives rename (already worked; still passes).
3. FOREIGN KEY in another table — both invalid and valid child inserts are validated against the renamed parent.
4. View body references a renamed table.
5. View projection / WHERE references a renamed column.
6. CTE-in-view (still skipped — depends on the parser fix tracked separately by `fix-view-validation-and-cte-edge-cases`).
7. Index-on-expression error path.
8. Aliased renamed table inside a view body.
9. CHECK on a different table referencing a third table by name.
10. Column rename where the column is referenced by another table's CHECK.

Test 3 (FK enforcement) requires the legitimate setup to be flushed (a verifying SELECT) before the rename: the planner queues FK checks as `initiallyDeferred: true`, so a deferred check enqueued before the rename would otherwise reference the old parent name at commit time. The test makes the checkpoint explicit with intermediate `select count(*)` blocks. Reviewers should be aware that this is a real interaction — pre-rename deferred FK checks against a soon-to-be-renamed parent will fail at commit. A future improvement might either flush the deferred queue inside `runRenameTable` or rebind queued evaluators; out of scope here.

## Validation

- `yarn test` — all 2522+ logic, optimizer, and planner tests pass.
- `yarn lint` (in `packages/quereus`) — clean.
- `yarn tsc --noEmit` — clean.

## Known limitations

- A user-defined CTE that intentionally shadows the renamed table inside a view (`with foo as (...) select ... from foo`) will be silently rewritten if `foo` is also the renamed table's name. This is an unusual edge case noted in the rewriter's design and not handled.
- ALTER TABLE rename does not flush pending deferred FK checks. If a child INSERT is queued for deferred validation in the same transaction as the parent rename, the deferred check still references the old parent name and will fail at commit. Document via the test pattern (verifying SELECT before rename) until a runtime-side flush is added.
- View change events: `SchemaChangeEvent` does not yet include a view-modified variant, so view rewrites do not emit notifications. Out of scope; tracked separately if/when sync clients need to observe view-body churn.
