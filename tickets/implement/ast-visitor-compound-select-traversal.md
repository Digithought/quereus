description: Fix `traverseAst` in `packages/quereus/src/parser/visitor.ts` so it descends into `stmt.compound?.select` (the field the parser actually populates) instead of the dead `stmt.union` field. Add regression tests covering both bind-parameter and non-determinism CHECK validators against a compound subquery.
prereq:
files:
  packages/quereus/src/parser/visitor.ts
  packages/quereus/test/logic/40.2-check-extras.sqllogic
----

## Background

The parser populates `SelectStmt.compound` (never `SelectStmt.union` /
`SelectStmt.unionAll`) for `UNION / UNION ALL / INTERSECT / EXCEPT / DIFF`
chains — see `packages/quereus/src/parser/parser.ts:577-619`.

`packages/quereus/src/parser/visitor.ts:74` traverses the dead `stmt.union`
field, so anything routed through `traverseAst` silently skips every leg
beyond the first in a compound SELECT.

`rename-rewriter.ts` already walks both fields (`packages/quereus/src/parser/rename-rewriter.ts:99,519`),
but the generic visitor does not. Callers of `traverseAst` that walk into a
compound subquery hidden inside a CHECK / DEFAULT / generated-column
expression therefore miss every leg after the first.

## Impact

`traverseAst` callers affected:

- `schema/manager.ts:rejectIllegalReferences` (called from CHECK + DEFAULT
  validation) — fails to detect bind-parameter or column references hidden in
  a compound subquery's later legs. e.g. `check (X in (select 1 union all
  select :p))` would slip past the no-bind-parameter rule today.
- `schema/manager.ts:validateCheckConstraintDeterminism` — fails to detect
  non-deterministic functions in later legs of a compound subquery inside a
  CHECK expression.
- `schema/table.ts:extractGeneratedColumnDependencies` — fails to pick up
  column refs from later legs of a compound subquery in a generated-column
  expression, which could silently mis-compute the topological sort of
  generated columns.

The existing cross-fix smoke test in `50-declarative-schema.sqllogic`
exercises a CHECK whose expression is a compound subquery, but only verifies
runtime INSERT behavior — the validation gaps above are not currently
covered.

## TODO

- In `packages/quereus/src/parser/visitor.ts` `case 'select':` arm, replace
  the dead `traverseAst(stmt.union, callbacks);` line with
  `traverseAst(stmt.compound?.select, callbacks);`.

- Add regression coverage in `packages/quereus/test/logic/40.2-check-extras.sqllogic`
  (after the existing section 6) for the two validator gaps:
  - `create table t_compound_param (x integer not null, check (x in (select 1 union all select :p)));`
    must fail with `-- error: bind parameters`.
  - `create table t_compound_nd (x integer not null, check (x in (select 1 union all select random())));`
    must fail with `-- error: Non-deterministic expression not allowed in CHECK`.
  Follow the file's existing `-- error: <substring>` convention; both DROP
  TABLE IF EXISTS cleanup lines should mirror sections 5 / 6.

- After the visitor fix lands, scan the codebase for any remaining readers
  of `SelectStmt.union` / `SelectStmt.unionAll` — at time of writing only
  `rename-rewriter.ts:99` and `rename-rewriter.ts:519`. If those are the
  only references, leave the AST fields in place (out of scope here, per the
  fix ticket); do NOT delete them unless the removal stays contained.

- Run `yarn build` (from `packages/quereus`) and `yarn test --grep
  '40.2-check-extras'`. A full `yarn test` is cheap (~50s) and worth doing
  to confirm no regression — the visitor change can affect any DDL caller
  of `traverseAst`.
