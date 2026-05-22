description: Review removal of dead `deferrable` / `initiallyDeferred` fields from `ColumnConstraint` and `TableConstraint` AST nodes and the four downstream consumer sites.
prereq:
files:
  packages/quereus/src/parser/ast.ts
  packages/quereus/src/schema/manager.ts
  packages/quereus/src/runtime/emit/add-constraint.ts
  packages/quereus/src/runtime/emit/alter-table.ts
----

## What changed

The parser never populated `ColumnConstraint.deferrable`, `ColumnConstraint.initiallyDeferred`, `TableConstraint.deferrable`, or `TableConstraint.initiallyDeferred`. Deferrability lives on `ForeignKeyClause` (`parser.ts:3716`) and is only meaningful for FK definitions. Three downstream sites forwarded those always-undefined values into `RowConstraintSchema`, which masked the dead-code dependency.

This ticket removes the two dead fields from each AST type and trims the four consumer sites that read them. `RowConstraintSchema.deferrable` / `initiallyDeferred` remain — the FK builder legitimately populates them on synthetic FK-existence checks (`planner/building/foreign-key-builder.ts`), and `runtime/emit/constraint-check.ts:108` reads them.

### Edits

- `packages/quereus/src/parser/ast.ts` — dropped `deferrable?: boolean` / `initiallyDeferred?: boolean` from `ColumnConstraint` and `TableConstraint`. `ForeignKeyClause` retains both fields.
- `packages/quereus/src/schema/manager.ts` — `extractCheckConstraints` no longer forwards `con.deferrable` / `con.initiallyDeferred` (in either the column-level or table-level CHECK push). Resulting `RowConstraintSchema` objects leave those fields undefined.
- `packages/quereus/src/runtime/emit/add-constraint.ts` — `emitAddConstraint` constraint-schema construction no longer reads from the constraint AST node for deferrability.
- `packages/quereus/src/runtime/emit/alter-table.ts` — `extractColumnLevelCheckConstraints` no longer reads from `con.deferrable` / `con.initiallyDeferred`.

## Out of scope (intentionally untouched)

- `RowConstraintSchema.deferrable` / `initiallyDeferred` on `schema/table.ts:347-350` — the FK builder still sets these on synthetic FK-existence checks and they drive deferred-check behavior at runtime.
- `ForeignKeyClause.deferrable` / `initiallyDeferred` — the parser sets them, the stringifier emits them (covered separately by `fix-fk-deferrable-stringify`), and `schema/manager.ts:862, 896` and `runtime/emit/alter-table.ts:355` read them.
- `IntegrityAssertionSchema.deferrable` / `initiallyDeferred` — separate concept.

## Validation performed

- `npx tsc --noEmit` in `packages/quereus` — clean (exit 0). The type-system removal would surface any remaining consumer; none.
- `npx eslint -c eslint.config.mjs 'src/**/*.ts'` — clean (exit 0).
- `yarn test` from `packages/quereus` — 3291 passing.
  - `test/logic/06.3.3-introspection-tags.sqllogic` continues to expect `deferrable: 0, initially_deferred: 0` for user CHECKs (line 159) — works because `sys_check_constraints` (`func/builtins/schema.ts:430-431`) coerces `undefined` → `0` via `cc.deferrable ? 1 : 0`.
  - `test/util/schema-equivalence.ts` compares `a.deferrable ?? false` on `RowConstraintSchema` — unaffected since that type wasn't touched.
  - `test/emit/ast-stringify.spec.ts` and `test/emit-roundtrip-property.spec.ts` — only assert deferrability on `ForeignKeyClause`, unaffected.

## Reviewer focus

1. Confirm no consumer of `ColumnConstraint` / `TableConstraint` still expects these fields (the type removal should have flushed them out, but cross-check `find_references` on the field names against the AST types).
2. Confirm the `RowConstraintSchema.deferrable` field is genuinely still used — if not, this could cascade into a follow-up cleanup ticket.
3. Confirm the `sys_check_constraints` introspection output (`deferrable: 0, initially_deferred: 0`) remains correct semantically: since user-written CHECKs never had deferrability in the AST anyway, the values were always `0` and will remain so.

## Known gaps

- Not exercised: `yarn test:store`. The change is purely AST-field removal with no runtime semantic shift, so the store path should be unaffected, but reviewer may want to confirm if they suspect anything store-specific reads these AST fields (none was found by grep over `src/`).
