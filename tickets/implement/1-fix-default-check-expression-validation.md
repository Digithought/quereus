description: Reject bind parameters and out-of-scope column references in DEFAULT and CHECK expressions at CREATE TABLE time.
prereq:
files:
  packages/quereus/src/schema/manager.ts
  packages/quereus/src/planner/validation/determinism-validator.ts
  packages/quereus/src/parser/ast.ts
  packages/quereus/src/parser/visitor.ts
  packages/quereus/test/logic/03.4.1-default-edge-cases.sqllogic
  packages/quereus/test/logic/40.2-check-extras.sqllogic
  docs/runtime.md
----

## Summary

Two existing validators in `SchemaManager` already run at CREATE TABLE time but
miss three classes of invalid expressions. Extend them.

- `validateDefaultDeterminism` (`packages/quereus/src/schema/manager.ts:840`)
  builds the DEFAULT expression with a `ParameterScope` wrapping a
  `GlobalScope` and then checks `physical.deterministic`. Bind parameters
  resolve cleanly to a `ParameterReferenceNode` whose default
  `PhysicalProperties` has `deterministic: true`, so `:xyz` slips through.
  Column references (`x + 1`) raise during build, but the `catch (_e)` block
  silently swallows the error so the bad DEFAULT is accepted.
- `validateCheckConstraintDeterminism` (`packages/quereus/src/schema/manager.ts:889`)
  does an AST walk that only looks up function symbols against the
  registry's `DETERMINISTIC` flag. It never rejects `ParameterExpr` nodes,
  so `check (a = ?)` and `check (a = :foo)` pass.

Both need a small AST pre-walk that rejects the offending node types with a
clear, DDL-time error.

## Required behaviour

### DEFAULT expressions

At CREATE TABLE / ALTER TABLE the DEFAULT must be evaluable from constants and
deterministic functions alone:

- Reject `ParameterExpr` (`?`, `:name`) anywhere in the expression.
- Reject `ColumnExpr` anywhere in the expression. (Generated columns exist
  for "value depends on other columns" — do not silently re-purpose DEFAULT
  for that.)
- Continue to reject non-deterministic function calls via the existing
  `physical.deterministic` check.

Error message should name the column and table, e.g.:

```
DEFAULT for column 'b' in table 't_param' may not reference bind parameters.
DEFAULT for column 'y' in table 't_colref' may not reference columns; use a generated column instead.
```

### CHECK expressions

At CREATE TABLE the CHECK must be a deterministic predicate over the row's
own state:

- Reject `ParameterExpr` (`?`, `:name`) anywhere in the expression.
- Continue to reject non-deterministic function calls via the existing AST
  walk.
- Column-reference scoping (e.g. preventing references to columns of *other*
  tables) is not part of this fix — CHECK runs against the row, and the
  existing INSERT/UPDATE constraint-build path already errors for unknown
  identifiers. Just the bind-param guard is required here.

Error message names the constraint and table, matching the existing
non-deterministic-function error shape.

## Implementation notes

- A small private helper in `manager.ts` (or alongside the existing
  validators in `planner/validation/determinism-validator.ts`) that walks
  the AST via `traverseAst` and throws on a forbidden `node.type` keeps
  both validators DRY.
- The DEFAULT pre-walk should run **before** `buildExpression`, so the
  bind-param / column-ref message wins over a less specific
  "column not found" build-time error.
- Remove (or narrow) the `catch (_e)` block around `buildExpression` in
  `validateDefaultDeterminism`. With the AST guard in place, column refs
  are caught explicitly. Other build-time failures should not be silently
  hidden — let them bubble or log+rethrow with a clear DDL-context
  message. (At minimum: don't allow a build error to mean "skip
  determinism check" — that masks real bugs.)
- The same `validateDefaultDeterminism` / `validateCheckConstraintDeterminism`
  helpers are only invoked from `createTable` today. ALTER TABLE
  `addColumn` / `addConstraint` / `alterColumn(setDefault)` paths have the
  same exposure but are out of scope for this ticket — note in
  `docs/runtime.md#determinism-validation` that the DDL-time guard
  currently fires only on CREATE TABLE, and call out the ALTER coverage as
  a follow-up if you want to file one.
- `docs/runtime.md` lines 942-944 currently state "CHECK constraints NOT
  validated (columns don't exist yet in scope)". That is already
  inaccurate — `validateCheckConstraintDeterminism` runs at CREATE TABLE.
  Update the section to reflect: function determinism + bind-param ban at
  CREATE TABLE, full column-scope validation at INSERT/UPDATE.

## Tests

- Uncomment the three TODO blocks in
  `packages/quereus/test/logic/03.4.1-default-edge-cases.sqllogic:89-92`
  (bind param) and `:98-101` (column ref) and
  `packages/quereus/test/logic/40.2-check-extras.sqllogic:115-122` (CHECK
  bind params, both `?` and `:foo`).
- Confirm `yarn test` passes (the rest of those files already cover the
  positive cases).
- Spot-check that pre-existing positive defaults still work: negative
  literals, INTEGER bounds, REAL, DEFAULT + NOT NULL + UNIQUE + CHECK
  combo (same files).

## TODO

- Add an `assertNoBindParamsOrColumnRefs(expr, context)` helper (or two
  separate single-purpose helpers) using `traverseAst` to flag
  `ParameterExpr` / `ColumnExpr` AST nodes.
- Wire the helper into `validateDefaultDeterminism` before the
  `buildExpression` call; flag bind params and column refs with
  column/table-named errors.
- Wire the bind-param half into `validateCheckConstraintDeterminism`
  alongside the existing function-determinism walk; flag with
  constraint/table-named errors.
- Remove the silent `catch (_e)` masking in
  `validateDefaultDeterminism` (now that column refs are rejected
  explicitly); rethrow build-time failures with a `DEFAULT for column ...`
  prefix, or let them propagate.
- Uncomment the three reproductions in the two `.sqllogic` files and run
  `yarn test` from the repo root.
- Run `yarn lint` in `packages/quereus` (single-quoted globs on Windows).
- Update `docs/runtime.md#determinism-validation` (the "Validation Timing"
  subsection around line 940) so it matches the new behaviour.
