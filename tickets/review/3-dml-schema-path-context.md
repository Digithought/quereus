description: Fix DML builders to propagate contextWithSchemaPath consistently
dependencies: none
files:
  packages/quereus/src/planner/building/update.ts
  packages/quereus/src/planner/building/delete.ts
  packages/quereus/src/planner/building/insert.ts
  packages/quereus/test/logic/06.4-schema-search-path.sqllogic
----

### Summary

Fixed 4 sites across UPDATE, DELETE, and INSERT builders where the base `ctx` was passed
instead of `contextWithSchemaPath`, causing `WITH SCHEMA` on DML statements to fail when
targeting tables in non-default schemas.

Each fix is a single-token change: `ctx` → `contextWithSchemaPath`.

### Changes

1. **update.ts:68** — Source scan `buildTableReference` now receives `contextWithSchemaPath`
2. **update.ts:80** — `updateCtx` (used for SET/WHERE) now derives from `contextWithSchemaPath`
3. **delete.ts:79** — `deleteCtx` (used for WHERE) now derives from `contextWithSchemaPath`
4. **insert.ts:528** — `createRowExpansionProjection` now receives `contextWithSchemaPath`

### Test Coverage

Tests in `06.4-schema-search-path.sqllogic` (Tests 14–17):
- Test 14: UPDATE with WITH SCHEMA on non-default schema
- Test 15: INSERT with WITH SCHEMA on non-default schema (default value computation)
- Test 16: DELETE with WITH SCHEMA on non-default schema
- Test 17: INSERT with WITH SCHEMA + RETURNING on non-default schema

### Validation

- `yarn workspace @quereus/quereus test --grep "schema-search-path"` — passes
- Full test suite — 182 passing, 1 pre-existing failure (alterTable stringify, unrelated)
