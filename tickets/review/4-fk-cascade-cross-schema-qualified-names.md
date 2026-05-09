description: FK CASCADE/SET NULL/SET DEFAULT actions now use schema-qualified table names
prereq: none
files:
  packages/quereus/src/runtime/foreign-key-actions.ts
  packages/quereus/test/logic/41-fk-cross-schema.sqllogic
----
## Summary

`executeSingleFKAction` previously generated SQL with unqualified child table names (`DELETE FROM "tablename"`), which would target the wrong table — or fail to find one — when the child table lived in a non-default schema. CASCADE DELETE/UPDATE, SET NULL, and SET DEFAULT all shared the bug.

## Change

`packages/quereus/src/runtime/foreign-key-actions.ts`:
- Introduced a single `qualifiedChildTable` constant in `executeSingleFKAction`: `` `"${childTable.schemaName}"."${childTable.name}"` ``.
- Replaced all four SQL template strings (DELETE for CASCADE, UPDATE for CASCADE, SET NULL, SET DEFAULT) to use the qualified form.

No other code paths or interfaces touched.

## Test coverage

Extended `packages/quereus/test/logic/41-fk-cross-schema.sqllogic` with a new section that declares schema `sa` containing a `parents` table plus three child tables — one each for CASCADE (with both `ON DELETE CASCADE ON UPDATE CASCADE`), SET NULL, and SET DEFAULT (with `DEFAULT 99`). Each child references its own parent row to keep actions independent. Test exercises:

- `DELETE FROM sa.parents WHERE id = 1` → cascades through to remove `cascade_children` rows.
- `UPDATE sa.parents SET id = 222 WHERE id = 2` → cascades to update child FK column.
- `DELETE FROM sa.parents WHERE id = 3` → SET NULL fires on `setnull_children`.
- `DELETE FROM sa.parents WHERE id = 4` → SET DEFAULT puts `parent_id = 99` on `setdefault_children`.

Note: declarative-schema columns are NOT NULL by default (see `columnDefToSchema` defaultNotNull=true in `src/schema/table.ts:112`), so the test column declarations explicitly use `NULL` to make `parent_id` nullable for the SET NULL action.

## Validation

- `yarn workspace @quereus/quereus run build` — clean.
- `node test-runner.mjs --grep "fk-cross-schema"` — passes.
- `node test-runner.mjs --grep "fk-|foreign-key|constraint-edge"` — 6/6 pass.
- Full `node test-runner.mjs` — 2694 passing, 2 pending (pre-existing).

## Review focus

- Confirm no other emitter in the FK pipeline still uses unqualified table names (e.g. parent-side check generation, MATCH propagation if any). The fix here is scoped to `executeSingleFKAction`; other FK SQL generation should already be schema-aware (the prior `41-fk-cross-schema` test established this for parent-side checks).
- Whether `expressionToString` for the SET DEFAULT path should ever produce identifier references to other tables (it currently doesn't — defaults are scalar expressions — but worth a sanity glance).
