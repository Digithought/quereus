description: Remove the dead `deferrable` / `initiallyDeferred` fields from `ColumnConstraint` and `TableConstraint` in the AST, and prune the downstream sites that read them. The parser never sets these (only `ForeignKeyClause` gets them, via `parseForeignKeyClause`), so every consumer is reading `undefined` and forwarding it. `RowConstraintSchema.deferrable` stays — the FK builder synthesizes constraint checks that legitimately use it.
prereq: fix-fk-deferrable-stringify
files:
  packages/quereus/src/parser/ast.ts
  packages/quereus/src/schema/manager.ts
  packages/quereus/src/runtime/emit/add-constraint.ts
  packages/quereus/src/runtime/emit/alter-table.ts
----

## Decision

**Option 1 from the fix ticket — drop the AST fields.**

Verified by grep: the parser never populates `ColumnConstraint.deferrable`, `ColumnConstraint.initiallyDeferred`, `TableConstraint.deferrable`, or `TableConstraint.initiallyDeferred`. `parseForeignKeyClause` writes deferrability onto the `ForeignKeyClause` shape only (`parser.ts:3716`), and that path is untouched here.

The three downstream sites that read `con.deferrable` / `con.initiallyDeferred` from these AST types do so blindly:

- `schema/manager.ts:799-800, 814-815` — `extractCheckConstraints` passes them into `RowConstraintSchema`. Both inputs are always `undefined`.
- `runtime/emit/add-constraint.ts:57-58` — `constraint` is `AST.TableConstraint`; same story.
- `runtime/emit/alter-table.ts:324-325` — `extractColumnLevelCheckConstraints` reads from `AST.ColumnConstraint`; same story.

`RowConstraintSchema.deferrable` is a separate field on a different type (`schema/table.ts:347-350`) and IS meaningfully populated by the FK builder (`planner/building/foreign-key-builder.ts:173, 240, 302, 372`) for synthetic FK-existence checks, and consumed by `runtime/emit/constraint-check.ts:108`. Leave that field alone.

The user-visible introspection output (`sys_check_constraints` via `func/builtins/schema.ts:430-431`) already shows `deferrable: 0` for user-written CHECKs (see `test/logic/06.3.3-introspection-tags.sqllogic:159`), so removing the dead pass-through is consistent with current behavior — `cc.deferrable` ends up `undefined`, which already renders as `0`. After the fix, that becomes `false`/`undefined` by construction rather than by accident.

## Edits

### `packages/quereus/src/parser/ast.ts`

Remove from `ColumnConstraint` (lines 432-433):
```ts
deferrable?: boolean;
initiallyDeferred?: boolean;
```

Remove from `TableConstraint` (lines 446-447):
```ts
deferrable?: boolean;
initiallyDeferred?: boolean;
```

Leave `ForeignKeyClause.deferrable` / `initiallyDeferred` (lines 457-458) untouched.

### `packages/quereus/src/schema/manager.ts`

In `extractCheckConstraints` (around lines 794-820), drop the two `deferrable` / `initiallyDeferred` properties from both pushed `RowConstraintSchema` objects (column-level and table-level CHECK paths). They'll default to `undefined` on the schema, matching every other call site that doesn't set them.

### `packages/quereus/src/runtime/emit/add-constraint.ts`

In `emitAddConstraint`'s constraint-schema construction (lines 53-59), drop:
```ts
deferrable: constraint.deferrable ?? false,
initiallyDeferred: constraint.initiallyDeferred,
```

### `packages/quereus/src/runtime/emit/alter-table.ts`

In `extractColumnLevelCheckConstraints` (lines 316-330), drop:
```ts
deferrable: con.deferrable,
initiallyDeferred: con.initiallyDeferred,
```

## Out of scope

- `RowConstraintSchema.deferrable` / `initiallyDeferred`: stay (FK builder uses them).
- `ForeignKeyClause.deferrable` / `initiallyDeferred`: stay (the parser sets them and the stringifier emits them; already covered by `fix-fk-deferrable-stringify`).
- `IntegrityAssertionSchema.deferrable` / `initiallyDeferred`: separate type, not touched.

## TODO

Drop the dead fields from `ColumnConstraint` in `parser/ast.ts:432-433`.

Drop the dead fields from `TableConstraint` in `parser/ast.ts:446-447`.

Drop the dead `deferrable` / `initiallyDeferred` reads in `schema/manager.ts:799-800` (column-level CHECK extract).

Drop the dead `deferrable` / `initiallyDeferred` reads in `schema/manager.ts:814-815` (table-level CHECK extract).

Drop the dead `deferrable` / `initiallyDeferred` reads in `runtime/emit/add-constraint.ts:57-58`.

Drop the dead `deferrable` / `initiallyDeferred` reads in `runtime/emit/alter-table.ts:324-325` (`extractColumnLevelCheckConstraints`).

Run `yarn workspace @quereus/quereus run build` and resolve any newly surfaced compile errors — there should be none beyond the edited files, but the type removal is what flushes out any missed consumer.

Run `yarn workspace @quereus/quereus run lint` (single-quoted globs on Windows).

Run `yarn test`. Pay particular attention to:
- `test/emit-roundtrip-property.spec.ts` — already only attaches deferrability to `ForeignKeyClause`, so unaffected.
- `test/emit/ast-stringify.spec.ts` — only asserts FK deferrability round-trip.
- `test/logic/06.3.3-introspection-tags.sqllogic` — `sys_check_constraints` still expected to return `deferrable: 0, initially_deferred: 0`. After the edit, `cc.deferrable` is `undefined` → `0`. ✓
- `test/util/schema-equivalence.ts:140-141` — compares `a.deferrable ?? false` on `RowConstraintSchema`; unaffected since we're not touching that type.
