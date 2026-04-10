description: Add foreign_key_info(table_name) TVF for FK introspection
dependencies: none
files: packages/quereus/src/func/builtins/schema.ts, packages/quereus/src/schema/table.ts, docs/functions.md
----

## Problem

There is no way for users to introspect foreign key constraints. The `ForeignKeyConstraintSchema` is fully populated internally (constraint name, child/parent columns, referenced table/schema, on delete/update actions, deferred flag) and enforced at runtime, but no TVF exposes this metadata.

## Proposed function

`foreign_key_info(table_name)` — consistent with `table_info()` and `function_info()` naming.

### Columns

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER | FK constraint index (0-based, per table) |
| `name` | TEXT? | Constraint name (if named) |
| `table` | TEXT | Child (source) table name |
| `from` | TEXT | Child column name |
| `referenced_table` | TEXT | Parent (referenced) table name |
| `referenced_schema` | TEXT? | Parent schema name (null if same schema) |
| `to` | TEXT | Parent column name |
| `on_update` | TEXT | Action on parent UPDATE (`'noAction'`, `'cascade'`, `'setNull'`, `'setDefault'`, `'restrict'`) |
| `on_delete` | TEXT | Action on parent DELETE |
| `deferred` | INTEGER | 1 if enforcement is deferred to COMMIT |
| `seq` | INTEGER | Column sequence within the FK (0-based, for composite FKs) |

Multi-column FKs produce one row per column, sharing the same `id` and differentiated by `seq`.

### Source data

`ForeignKeyConstraintSchema` in `packages/quereus/src/schema/table.ts` (line 312) has all needed fields. Column indices need to be resolved to names via the table's `columns` array, and referenced column names via `referencedColumnNames` (or falling back to parent PK columns via `resolveReferencedColumns`).

### Example usage

```sql
select * from foreign_key_info('orders');
-- id | name | table  | from        | referenced_table | referenced_schema | to   | on_update | on_delete | deferred | seq
-- 0  | NULL | orders | customer_id | customers        | NULL              | id   | noAction  | cascade   | 0        | 0
```

### Documentation

Add to the Schema Introspection TVFs table and add a columns subsection in `docs/functions.md`, following the pattern of `table_info()` and `function_info()`.
