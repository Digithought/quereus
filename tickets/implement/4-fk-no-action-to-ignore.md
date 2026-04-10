description: Rename FK enforcement action "noAction" to "ignore" for clarity
dependencies: none
files:
  - packages/quereus/src/parser/ast.ts (ForeignKeyAction type, line 455)
  - packages/quereus/src/parser/parser.ts (parseForeignKeyAction return, line 3458)
  - packages/quereus/src/emit/ast-stringify.ts (foreignKeyActionToString case, line 942)
  - packages/quereus/src/schema/manager.ts (defaults on lines 661-662, 688-689)
  - packages/quereus/src/schema/table.ts (doc comments, lines 330, 332)
  - packages/quereus/src/runtime/foreign-key-actions.ts (skip logic, line 58)
  - packages/quereus/src/planner/building/foreign-key-builder.ts (parent-side check, line 258)
----

Rename `'noAction'` → `'ignore'` in the internal `ForeignKeyAction` union type and all references. SQL parsing and emission remain unchanged — `NO ACTION` is still parsed and emitted as `no action`.

## Changes

**Type definition** — `packages/quereus/src/parser/ast.ts:455`
- Change the union member from `'noAction'` to `'ignore'`

**Parser** — `packages/quereus/src/parser/parser.ts:3458`
- `parseForeignKeyAction()` still parses `NO ACTION` but returns `'ignore'` instead of `'noAction'`

**AST stringify** — `packages/quereus/src/emit/ast-stringify.ts:942`
- Case label changes from `'noAction'` to `'ignore'`; still emits `'no action'` string

**Schema manager** — `packages/quereus/src/schema/manager.ts:661-662, 688-689`
- Four default fallbacks: `?? 'noAction'` → `?? 'ignore'`

**Schema table** — `packages/quereus/src/schema/table.ts:330, 332`
- Update doc comments from `'noAction'` to `'ignore'`

**Runtime FK actions** — `packages/quereus/src/runtime/foreign-key-actions.ts:58`
- Condition `action === 'noAction'` → `action === 'ignore'`

**FK builder** — `packages/quereus/src/planner/building/foreign-key-builder.ts:258`
- Condition `action !== 'noAction'` → `action !== 'ignore'`

## Testing

Existing FK tests (`test/logic/41-foreign-keys.sqllogic`) should pass unchanged — this is a purely internal rename with no behavioral change. Run `yarn build && yarn test` to confirm.

## TODO

- [ ] Update `ForeignKeyAction` type in ast.ts
- [ ] Update parser return value in parser.ts
- [ ] Update case label in ast-stringify.ts
- [ ] Update four default fallbacks in schema/manager.ts
- [ ] Update two doc comments in schema/table.ts
- [ ] Update condition in foreign-key-actions.ts
- [ ] Update condition in foreign-key-builder.ts
- [ ] Run build and tests
