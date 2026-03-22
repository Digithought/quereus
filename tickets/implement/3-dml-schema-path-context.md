description: Fix DML builders to propagate contextWithSchemaPath consistently
dependencies: none
files:
  packages/quereus/src/planner/building/update.ts
  packages/quereus/src/planner/building/delete.ts
  packages/quereus/src/planner/building/insert.ts
  packages/quereus/test/logic/06.4-schema-search-path.sqllogic (reproducing tests already added)
----

### Root Cause

When `WITH SCHEMA` is used on DML statements targeting non-default schemas, several
codepaths pass the base `ctx` instead of `contextWithSchemaPath`. The `contextWithSchemaPath`
context is correctly created at the top of each builder (by spreading `ctx` with the
statement's `schemaPath`), but not all downstream calls receive it.

`resolveTableSchema` in `schema-resolution.ts` uses `ctx.schemaPath` to search non-default
schemas when no explicit schema qualifier is present. Passing the base `ctx` (no `schemaPath`)
causes resolution to fall back to the default search path (`main, temp`), failing for tables
in custom schemas.

### Confirmed Reproduction

Test 14 in `06.4-schema-search-path.sqllogic`:
```
UPDATE products SET name = 'Gadget' WHERE id = 1 WITH SCHEMA myapp;
```
Fails with: `Table 'products' not found in schema path: main`

Stack trace confirms `buildTableReference` at `update.ts:68` resolves against the wrong
schema path because `ctx` lacks `schemaPath`.

### Fixes (4 sites, same pattern)

#### 1. update.ts:68 — Source scan uses base ctx
```typescript
// BEFORE:
let sourceNode: RelationalPlanNode = buildTableReference({ type: 'table', table: stmt.table }, ctx);
// AFTER:
let sourceNode: RelationalPlanNode = buildTableReference({ type: 'table', table: stmt.table }, contextWithSchemaPath);
```

#### 2. update.ts:80 — updateCtx derives from base ctx
SET and WHERE expressions (including subqueries) would fail to resolve tables in the
schema path.
```typescript
// BEFORE:
const updateCtx = { ...ctx, scope: tableScope };
// AFTER:
const updateCtx = { ...contextWithSchemaPath, scope: tableScope };
```

#### 3. delete.ts:79 — deleteCtx derives from base ctx
WHERE clause subqueries would fail to resolve tables in the schema path.
```typescript
// BEFORE:
const deleteCtx = { ...ctx, scope: tableScope };
// AFTER:
const deleteCtx = { ...contextWithSchemaPath, scope: tableScope };
```

#### 4. insert.ts:528 — Row expansion uses base ctx
Default expressions and generated column computations would fail to resolve tables in
the schema path (matters when defaults contain subqueries or function calls requiring
schema resolution).
```typescript
// BEFORE:
const expandedSourceNode = createRowExpansionProjection(ctx, sourceNode, targetColumns, tableReference, contextScope);
// AFTER:
const expandedSourceNode = createRowExpansionProjection(contextWithSchemaPath, sourceNode, targetColumns, tableReference, contextScope);
```

### Test Coverage

Tests already added to `06.4-schema-search-path.sqllogic` (Tests 14–17):
- Test 14: UPDATE with WITH SCHEMA on non-default schema
- Test 15: INSERT with WITH SCHEMA on non-default schema (default value computation)
- Test 16: DELETE with WITH SCHEMA on non-default schema
- Test 17: INSERT with WITH SCHEMA + RETURNING on non-default schema

### TODO

- Apply the 4 one-line fixes listed above
- Run `yarn workspace @quereus/quereus test --grep "schema-search-path"` to verify all tests pass
- Run full test suite to check for regressions
