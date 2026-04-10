description: Rename FK enforcement action "noAction" to "ignore" for clarity
dependencies: none
files: packages/quereus/src/parser/ast.ts, packages/quereus/src/parser/parser.ts, packages/quereus/src/emit/ast-stringify.ts, packages/quereus/src/schema/manager.ts, packages/quereus/src/schema/table.ts, packages/quereus/src/runtime/foreign-key-actions.ts, packages/quereus/src/planner/building/foreign-key-builder.ts, packages/quereus/test/logic/41-foreign-keys.sqllogic, docs/sql.md
----

The SQL standard uses "NO ACTION" as a foreign key enforcement action, but internally our `ForeignKeyAction` type uses `'noAction'` which is vague—it could mean "do nothing" or "not yet configured." Rename to `'ignore'` throughout the codebase for clarity of intent.

Key touchpoints:

- `ForeignKeyAction` union type in `parser/ast.ts` — rename `'noAction'` → `'ignore'`
- Parser (`parser.ts`) — still parse `NO ACTION` from SQL but map to `'ignore'`
- AST stringify (`ast-stringify.ts`) — emit `'no action'` SQL from `'ignore'` (preserve SQL compat)
- Schema manager defaults (`schema/manager.ts`) — default to `'ignore'`
- Schema table doc comments (`schema/table.ts`)
- Runtime FK actions (`runtime/foreign-key-actions.ts`) — skip logic for `'ignore'`
- FK builder (`planner/building/foreign-key-builder.ts`) — parent-side check condition
- Tests and docs as needed
