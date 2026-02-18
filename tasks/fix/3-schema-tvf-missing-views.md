---
description: schema() TVF does not include views in its output
dependencies: none

---

# schema() TVF Missing Views

The `schema()` table-valued function in `src/func/builtins/schema.ts` only iterates `schemaInstance.getAllTables()` (line 50), which returns only tables. Views are stored in a separate `Schema.views` map (added via `addView()`), and `getAllViews()` exists but is never called in the schema function.

The code at line 61 checks `tableSchema.isView ? 'view' : 'table'` but views can never appear in the iteration since they aren't in the tables collection.

## Expected Behavior

`select * from schema()` should return rows for both tables and views, with the `type` column correctly set to `'view'` for views.

## Hypothesis

After the table iteration loop (ending around line 96), add a second loop over `schemaInstance.getAllViews()` that yields view rows with `type = 'view'` and their column information.

## Key Files

- `packages/quereus/src/func/builtins/schema.ts` — the schema() TVF implementation (line 50 is the table loop)
- `packages/quereus/src/schema/schema.ts` — `getAllTables()` (line 60) and `getAllViews()` method
- `packages/quereus/test/integration-boundaries.spec.ts` — existing test verifies views work via query but not via schema() output

