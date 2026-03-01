description: schema() TVF now includes views in its output
dependencies: none
files:
  - packages/quereus/src/func/builtins/schema.ts
  - packages/quereus/test/logic/06.3-schema.sqllogic
----

# schema() TVF - Views Support

## What was done

Added a view iteration loop in `schema()` TVF (`packages/quereus/src/func/builtins/schema.ts:98-106`) after the table/index loop. It calls `schemaInstance.getAllViews()` and yields rows with `type = 'view'`, the view name, and the original SQL.

## Testing

- Added sqllogic tests in `06.3-schema.sqllogic` verifying:
  - Views appear in `schema()` output with `type = 'view'`
  - View SQL is correctly returned
  - `SELECT DISTINCT type FROM schema()` includes `'view'` when views exist
- All 751 tests pass

## Usage

```sql
-- Create a view
create view my_view as select id, name from my_table where active = 1;

-- See it in schema()
select * from schema() where type = 'view';
-- Returns: type='view', name='my_view', tbl_name='my_view', sql='create view ...'
```
