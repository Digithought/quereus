description: Review foreign_key_info(table_name) TVF implementation
dependencies: none
files:
  - packages/quereus/src/func/builtins/schema.ts (foreignKeyInfoFunc at ~line 194)
  - packages/quereus/src/func/builtins/index.ts (registration at ~line 24, 152)
  - packages/quereus/test/logic/06.3.2-schema-foreign-keys.sqllogic
  - docs/functions.md (Schema Introspection TVFs section)
----

## What was built

`foreign_key_info(table_name)` table-valued function that exposes foreign key constraint metadata for a given table.

### Output columns (11)

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER | FK index (0-based), shared by multi-column FK columns |
| `name` | TEXT? | Constraint name (auto-generated or explicit) |
| `table` | TEXT | Child table name |
| `from` | TEXT | Child column name |
| `referenced_table` | TEXT | Parent table name |
| `referenced_schema` | TEXT? | Parent schema (null if same schema) |
| `to` | TEXT | Parent column name |
| `on_update` | TEXT | Update action string |
| `on_delete` | TEXT | Delete action string |
| `deferred` | INTEGER | 1 if deferred |
| `seq` | INTEGER | Column sequence within FK (0-based) |

### Parent column resolution

1. Uses `fk.referencedColumnNames[seq]` if available
2. Falls back to looking up parent table via `db._findTable()` and resolving from column index
3. Falls back to stringified column index if parent table not found

## Testing

Test file: `packages/quereus/test/logic/06.3.2-schema-foreign-keys.sqllogic`

Test cases:
- Basic single-column FK: verifies all columns
- Table with no FKs: empty result
- Named constraint: verifies name column populated
- ON DELETE/UPDATE actions: cascade, restrict
- Multiple FKs on one table: distinct id values
- Composite FK: multiple rows with same id, different seq
- Auto-generated constraint name
- Nonexistent table: error

## Usage

```sql
select "from", "to", on_delete from foreign_key_info('orders');
select * from foreign_key_info('child_table') where on_delete = 'cascade';
```
