description: Review DDL-time bind-param / column-ref validation for DEFAULT and CHECK expressions.
prereq:
files:
  packages/quereus/src/schema/manager.ts
  packages/quereus/test/logic/03.4.1-default-edge-cases.sqllogic
  packages/quereus/test/logic/40.2-check-extras.sqllogic
  packages/quereus/test/logic/46-mutation-context.sqllogic
  docs/runtime.md
----

## What landed

DDL-time validators in `SchemaManager` (`packages/quereus/src/schema/manager.ts`)
were tightened so invalid DEFAULT and CHECK expressions are caught at
`CREATE TABLE` time instead of bubbling up later (or, worse, slipping through).

Concrete changes:

- New private helper `rejectIllegalReferences(expr, options)` does an AST
  pre-walk via `traverseAst` and throws a `QuereusError` on the first
  forbidden node it sees. It supports two modes: param-only, and
  param+column.
- `validateDefaultDeterminism(columns, tableName, hasMutationContext)`:
  - Always rejects `ParameterExpr` nodes in DEFAULTs ("may not reference
    bind parameters").
  - Rejects `ColumnExpr` nodes in DEFAULTs **only when the table has no
    mutation context** ("use a generated column instead"). See "Design
    decision" below.
  - The previous silent `catch (_e)` around `buildExpression` is narrowed:
    when no mutation context exists, build-time errors now propagate
    (re-wrapped with a `DEFAULT for column '...' in table '...' is
    invalid: ...` prefix). When mutation context **is** present, build
    errors are still swallowed (with a debug log), since column-style
    identifiers may resolve to context vars at INSERT time and the row
    scope isn't available yet.
- `validateCheckConstraintDeterminism(checkConstraints, tableName)` now
  runs an additional AST pre-walk that rejects `ParameterExpr` nodes
  before the existing function-determinism walk. Error names the
  constraint and table.

The `createTable` path (`manager.ts:~1271`) computes `hasMutationContext`
from the built table schema and passes it through.

## Design decision worth a second look

The ticket asked to reject `ColumnExpr` *anywhere* in DEFAULT and pointed
to a positive test case in `03.4.1-default-edge-cases.sqllogic` for the
no-mutation-context flavor. But Quereus already supports DEFAULTs that
reference both row columns and mutation-context variables — see
`46-mutation-context.sqllogic:5-20`, where
`final_price INTEGER DEFAULT base_price + markup` is established
behaviour: `markup` is a `WITH CONTEXT` variable, `base_price` is a real
column of the same table, and the DEFAULT correctly evaluates to
`base_price + markup` at INSERT time.

Both `markup` and `base_price` are `ColumnExpr` AST nodes (the parser
emits a `column` node for any unqualified identifier). The AST cannot
tell a context variable from a row-column reference; that distinction is
made at INSERT time when the row scope is established.

Outright banning `ColumnExpr` in DEFAULT would break that test (and the
feature). The ticket didn't mention `46-mutation-context.sqllogic`, so
this is plausibly an oversight in the ticket rather than a deliberate
break.

The implementation chose the **defensible default** the workflow rules
prescribe: ban column refs only when the table has no mutation context.
This satisfies both:
- `03.4.1` `t_colref` (no mutation context) → rejected with the new
  message.
- `46-mutation-context` (mutation context defined) → still works,
  validation deferred to INSERT time.

Reviewer should decide whether the broader ban (and a rewrite of the
mutation-context tests to use generated columns or context-only
expressions) is desirable as a follow-up. If so, the gating should move
from `hasMutationContext` to a stricter rule (for example: reject
`ColumnExpr` always, but allow a dedicated mutation-context-variable AST
node — would require parser/scope changes).

## What to verify in review

- Bind parameter rejection paths:
  - `t_param` in `03.4.1-default-edge-cases.sqllogic:89-91` — DEFAULT
    with `:xyz` errors at CREATE TABLE.
  - `t_p` and `t_p2` in `40.2-check-extras.sqllogic:115-122` — CHECK
    with `?` and `:foo` both error at CREATE TABLE.
  - Error messages cite the column / constraint and table by name.
- Column-ref rejection (no mutation context):
  - `t_colref` in `03.4.1-default-edge-cases.sqllogic:98-100` — DEFAULT
    referencing another column errors with the "use a generated column
    instead" message.
- Positive cases unaffected:
  - All the negative-literal / boundary / REAL / NOT NULL+UNIQUE+CHECK
    cases in `03.4.1` still pass.
  - All the typeof / CASE+BETWEEN / COLLATE / INSERT...SELECT cases in
    `40.2` still pass.
  - `46-mutation-context.sqllogic` (full file) still passes — DEFAULT
    expressions that reference row columns plus context vars continue
    to work.
- Tests: `yarn test` from repo root → 2522 passing, 3 pending, 0 failing.
- Lint: `yarn lint` (single-quoted globs on Windows) clean.
- Build: `yarn build` clean.

## Known gaps / follow-ups

- The new validators only run from `createTable`. ALTER TABLE paths
  (`addColumn`, `addConstraint`, `alterColumn(setDefault)`) are not yet
  routed through them — out of scope for this ticket. `docs/runtime.md`
  notes this explicitly. Filing a follow-up ticket is reasonable.
- Whether to ban `ColumnExpr` in DEFAULT *even when* a mutation context
  exists — see "Design decision" above. The reviewer's call.

## Files touched

- `packages/quereus/src/schema/manager.ts` — `rejectIllegalReferences`
  helper, updated `validateDefaultDeterminism` (new
  `hasMutationContext` parameter, narrowed catch), updated
  `validateCheckConstraintDeterminism`, updated `createTable` call site.
- `packages/quereus/test/logic/03.4.1-default-edge-cases.sqllogic` —
  uncommented `t_param` (bind param) and `t_colref` (column ref)
  reproductions.
- `packages/quereus/test/logic/40.2-check-extras.sqllogic` — uncommented
  `t_p` (`?`) and `t_p2` (`:foo`) CHECK reproductions.
- `docs/runtime.md` — corrected the "Validation Timing" subsection to
  reflect the new DDL-time guards (and called out the ALTER coverage
  gap).
