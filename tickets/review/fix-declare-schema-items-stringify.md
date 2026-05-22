description: Review the `DeclareSchema` item stringifier rewrite. Each declared-item kind (table, index, view, seed, assertion) now emits a real body that round-trips through `parse → stringify → parse`. New unit + property tests cover the kinds.
files:
  packages/quereus/src/emit/ast-stringify.ts
  packages/quereus/test/emit/ast-stringify.spec.ts
  packages/quereus/test/emit-roundtrip-property.spec.ts
----

## What changed

`packages/quereus/src/emit/ast-stringify.ts`

- Replaced the stubbed `declareItemToString` (which emitted placeholders like `table X { ... }`) with a switch dispatching to per-kind formatters: `declaredTableToString`, `declaredIndexToString`, `declaredViewToString`, `declaredSeedToString`, `declaredAssertionToString`. `DeclareIgnoredItem` still falls back to its preserved `text`.
- Extracted three shared helpers used by both `createTableToString` and `declaredTableToString`:
  - `tableBodyDefsToString(stmt)` — emits `(<col defs>, <table constraints>)`.
  - `moduleClauseToString(stmt)` — emits `using <module>[(args)]`.
  - `contextClauseToString(stmt)` — emits `with context (...)`.
  Note: `moduleClauseToString` still uses `JSON.stringify` for arg values, matching the pre-existing behavior of `createTableToString`. That has a latent bug for string args (emits `"foo"` not `'foo'`) but is unchanged here — out of scope for this ticket and not exercised by any current test or arb.
- Extracted `indexedColumnsToString(cols)` used by both `createIndexToString` and `declaredIndexToString`.
- Added `sqlValueToSqlLiteral(value)` to render `SqlValue`s as SQL literals for seed rows (single-quoted strings with `''` escaping, `x'…'` for Uint8Array, `true`/`false`/`null` keywords, numeric/bigint as decimal). The prior implementation used `JSON.stringify`, which double-quoted strings and would not re-parse.

Declared-form grammar deltas vs the standalone CREATE forms (mirrored by the new formatters):

- Declared `table` puts `using <module>(args)` **before** the column body; standalone `create table` emits it after.
- Declared `index`/`view` omit `create`, `if not exists`, `temp`, and (for index) `where`. The parser doesn't accept those at item level, so the emitter doesn't produce them.
- Declared `assertion` omits the leading `create`.

## Tests

`packages/quereus/test/emit/ast-stringify.spec.ts` — added a `DECLARE SCHEMA items` suite with 7 cases covering each declared kind:
- declared table (columns + PK constraint)
- declared `unique` index over multi-column ASC/DESC list
- declared view body (SELECT survives, WHERE clause intact)
- declared seed with literal rows
- declared assertion CHECK expression
- WITH TAGS on declared table + index
- seed strings containing `'` escape correctly through round-trip

`packages/quereus/test/emit-roundtrip-property.spec.ts` — added `declareSchemaArb` and an `it('DECLARE SCHEMA round-trips structurally')` property test (100 runs). The arb generates 1–3 items mixing all five real declared kinds. Inner `CreateTableStmt`/`CreateViewStmt` shapes pin `ifNotExists`/`isTemporary` to `false` because the declarative grammar has no item-level keyword for them.

## Validation

- Unit suite: `yarn workspace @quereus/quereus run test --grep "ast-stringify"` — 10 passing (was 3).
- Round-trip suite: `yarn workspace @quereus/quereus run test --grep "round-trip"` — 173 passing (was 165: +7 unit, +1 property).
- Full quereus suite: `yarn workspace @quereus/quereus run test` — 3282 passing, 0 failing.
- Lint: `yarn workspace @quereus/quereus run lint` — clean (exit 0).

## Suggested review focus

- The shared-helper extraction (`tableBodyDefsToString`, `moduleClauseToString`, `contextClauseToString`, `indexedColumnsToString`) should be behavior-preserving for `createTableToString`/`createIndexToString`. Worth a quick eyeball against the previous inline code.
- `sqlValueToSqlLiteral` covers all `SqlValue` cases (`null`, `boolean`, `string`, `number`, `bigint`, `Uint8Array`, `JsonSqlValue`). The seed parser today only accepts what `this.expression()` returns as a `literal`, so `JsonSqlValue` won't round-trip back to an object (it becomes a quoted JSON string) — flagged here as a known limit rather than a fix target.
- Property-test arb intentionally constrains the inner statements (no `moduleArgs`, no `contextDefinitions`, no per-column tags, no schema-qualified names) because none of those grammars survive the declared-item wrap in the current parser. If reviewers want broader coverage, they're separate forward-compat tickets.
- `moduleClauseToString` keeps the pre-existing `JSON.stringify` behavior for arg values — known latent bug for string args, **unchanged** in this ticket. Worth a follow-up backlog ticket if reviewers want it filed.
