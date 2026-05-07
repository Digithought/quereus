description: ALTER TABLE RENAME (table or column) does not rewrite references in dependent objects (CHECK, FK, views)
prereq:
files:
  packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic
  packages/quereus/src/planner/building/alter-table.ts
  packages/quereus/src/runtime/emit/alter-table.ts
  packages/quereus/src/planner/nodes/alter-table-node.ts
  packages/quereus/src/schema/table.ts
  packages/quereus/src/schema/manager.ts
----

## Problem

`alter table ... rename to ...` and `alter table ... rename column ... to ...` mutate only the directly-targeted schema entity. References to that table/column held by *other* schema objects are left dangling or pointing at the old name:

- **Self-referencing CHECK constraints** on the renamed table still mention the old table name in their stored expression. After `rename to t_chk2`, the CHECK subquery `(select count(*) from t_chk)` is unchanged and either errors at next insert or silently misbehaves.
- **FOREIGN KEY references in other tables** that name the renamed parent table by its old name are not rewritten, so FK enforcement on the child table breaks (or worse, silently passes by failing to resolve the parent at all).
- **Views built on the renamed table** keep their original `from <old-name>` body and produce "no such table" on read, instead of transparently following the rename.
- **Views projecting / filtering on a renamed column** do not have their stored body rewritten; the view either errors on read or silently returns the wrong column.

There is no general-purpose dependency tracker in the schema layer that records "object X references table/column Y". Implementing rename propagation almost certainly requires building such a tracker (or doing best-effort AST rewrites at rename time after enumerating candidate dependents) — flagged here as part of the problem rather than prescribed; the implementer should design it.

Sub-bugs grouped under this ticket:
- self-table CHECK reference not rewritten (renamed table)
- FK in another table referencing the renamed parent not rewritten
- dependent view body not rewritten on `rename to`
- dependent view body not rewritten on `rename column`

The `13.4-cte-extras.sqllogic:106` view-with-CTE case is excluded from this ticket because it also depends on `create view ... as with ... select` not being parsed (covered by `1-fix-view-validation-and-cte-edge-cases`).

## Expected behavior

After `alter table ... rename to <new>` or `alter table ... rename column <old> to <new>`:

- CHECK constraints on the renamed table that mention the old table name resolve against the new name.
- FK constraints in other tables that named the renamed parent by its old name continue to enforce against the renamed parent (validation, cascade, RESTRICT, etc.).
- Views whose stored body references the renamed table or column transparently see the new name on next read.
- DML and reads against the renamed names succeed; reads against the old names fail with the usual "no such table/column".

## Reproduction

In `packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic`:

- Lines 9-20 (`-- TODO bug: ALTER TABLE RENAME does not rewrite self-referencing table name in CHECK constraint`) — `t_chk` -> `t_chk2`, then insert and `select count(*)`.
- Lines 42-64 (`-- TODO bug: ALTER TABLE RENAME does not propagate the new parent name into FK references`) — `parent_t` -> `parent_t2`, then verify FK enforcement on `child_t`.
- Lines 70-82 (`-- TODO bug: ALTER TABLE RENAME does not rewrite the table reference inside dependent views`) — `tv_src` -> `tv_src2`, then `select * from vv`.
- Lines 88-100 (`-- TODO bug: ALTER TABLE RENAME COLUMN does not rewrite the column reference inside dependent views`) — `t_vc.old_n` -> `t_vc.new_n`, then `select * from v_vc`.

Each block is currently commented out with a `-- TODO bug:` marker. Reviewers can uncomment to observe the failure.

## Likely investigation areas

- `packages/quereus/src/planner/building/alter-table.ts` and `packages/quereus/src/runtime/emit/alter-table.ts` — current rename handling.
- `packages/quereus/src/schema/manager.ts` and `packages/quereus/src/schema/table.ts` — where schema objects are stored and how stored CHECK / FK expressions and view bodies are kept (text vs. parsed AST).
- There is no existing dependency tracker linking views / FKs / CHECK expressions back to the tables/columns they reference; this likely needs to be added (or the rename path needs to enumerate all schema objects and re-resolve their stored ASTs against the new schema). The implementer should pick the approach.
- `packages/quereus/src/parser/ast.ts` and `packages/quereus/src/emit/ast-stringify.ts` for the round-trip needed to rewrite stored expression text.
