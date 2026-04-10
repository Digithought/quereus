description: Add foreign_key_info(table_name) TVF for FK introspection
dependencies: none
files:
  - packages/quereus/src/func/builtins/schema.ts (add TVF definition)
  - packages/quereus/src/func/builtins/index.ts (register TVF)
  - packages/quereus/src/schema/table.ts (ForeignKeyConstraintSchema, resolveReferencedColumns)
  - packages/quereus/test/logic/ (new sqllogic test file)
  - docs/functions.md (document in Schema Introspection TVFs section)
----

## Overview

Add `foreign_key_info(table_name)` table-valued function to expose foreign key constraint metadata, consistent with existing `table_info()` and `function_info()` naming.

## TVF Definition

Follow the exact pattern of `tableInfoFunc` in `schema.ts:141`:
- Use `createIntegratedTableValuedFunction` with `numArgs: 1`, `deterministic: false`
- Accept a single `tableName: SqlValue` argument (validate is string)
- Look up table via `db._findTable(tableName)`
- Iterate `table.foreignKeys` array (typed `ReadonlyArray<ForeignKeyConstraintSchema>`, field at `table.ts:61`)

### Output columns

| Column | Type | Nullable | Source |
|---|---|---|---|
| `id` | INTEGER | no | FK index in `foreignKeys` array (0-based) |
| `name` | TEXT | yes | `fk.name` (may be undefined) |
| `table` | TEXT | no | `table.name` (child table) |
| `from` | TEXT | no | `table.columns[fk.columns[seq]].name` |
| `referenced_table` | TEXT | no | `fk.referencedTable` |
| `referenced_schema` | TEXT | yes | `fk.referencedSchema` (undefined if same schema) |
| `to` | TEXT | no | Parent column name (see resolution below) |
| `on_update` | TEXT | no | `fk.onUpdate` (ForeignKeyAction string) |
| `on_delete` | TEXT | no | `fk.onDelete` (ForeignKeyAction string) |
| `deferred` | INTEGER | no | `fk.deferred ? 1 : 0` |
| `seq` | INTEGER | no | Column sequence within FK (0-based) |

Multi-column FKs produce one row per column pair, sharing the same `id`, differentiated by `seq`.

### Parent column name resolution

For the `to` column:
1. If `fk.referencedColumnNames` is populated, use `fk.referencedColumnNames[seq]` directly
2. Otherwise, try to resolve via parent table: look up parent with `db._findTable(fk.referencedTable)`, then use `parentTable.columns[fk.referencedColumns[seq]].name`
3. If parent table not found (cross-schema or not yet created), fall back to `fk.referencedColumns[seq]` as a string (the index number) — avoid throwing

### Registration

Export `foreignKeyInfoFunc` from `schema.ts`. Import and add to `builtinTableFunctions` array in `builtins/index.ts:149` alongside the other schema introspection functions.

## Documentation

In `docs/functions.md`, in the "Schema Introspection (TVFs)" section (~line 452):
1. Add row to the summary table: `| foreign_key_info(table_name) | 1 | Foreign key constraints for a specific table |`
2. Add a `### foreign_key_info(table_name) columns` subsection after the `function_info()` columns section (~line 489), listing all 11 columns
3. Add an example query to the existing sql code block

## Testing

Create `packages/quereus/test/logic/06.3.2-schema-foreign-keys.sqllogic` with tests for:
- Basic single-column FK: create parent + child tables, query `foreign_key_info('child')`, verify all columns
- Composite FK: multi-column FK producing multiple rows with same `id`, different `seq`
- Named constraint: verify `name` column is populated
- Multiple FKs on one table: verify distinct `id` values
- Table with no FKs: verify empty result set
- ON DELETE/UPDATE actions: verify action strings (`cascade`, `noAction`, etc.)
- Nonexistent table: verify error behavior (should throw like `table_info` does)

## TODO

### Phase 1: Implementation
- [ ] Add `foreignKeyInfoFunc` in `packages/quereus/src/func/builtins/schema.ts` after `tableInfoFunc`
- [ ] Export and register in `packages/quereus/src/func/builtins/index.ts`
- [ ] Update `docs/functions.md` Schema Introspection TVFs section

### Phase 2: Testing
- [ ] Create `packages/quereus/test/logic/06.3.2-schema-foreign-keys.sqllogic`
- [ ] Run build (`yarn build`) and verify no errors
- [ ] Run tests (`yarn test`) and verify all pass
