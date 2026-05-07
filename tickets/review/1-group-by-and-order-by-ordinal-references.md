description: Code review for GROUP BY / ORDER BY 1-based ordinal SELECT-list references
prereq:
files:
  packages/quereus/src/planner/building/select-ordinal.ts
  packages/quereus/src/planner/building/select.ts
  packages/quereus/src/planner/building/select-aggregates.ts
  packages/quereus/src/planner/building/select-modifiers.ts
  packages/quereus/test/logic/07.3-group-by-extras.sqllogic
  packages/quereus/test/logic/28.2-orderby-expression-extras.sqllogic
  packages/quereus/test/logic/90.6-select-error-paths.sqllogic
----

## What was implemented

`SELECT … GROUP BY N [, M…]` and `SELECT … ORDER BY N [, M…]` now resolve a bare positive integer literal `N` as a 1-based reference into the SELECT list, using the AST expression that produced the Nth output column. Out-of-range / zero / negative ordinals raise a planning-time error. Unary `+N` / `-N` (which the parser produces as `UnaryExpr` rather than a single literal) are also recognized so `order by -1` errors instead of silently sorting on the constant `-1`.

Anything other than a bare integer literal (or unary +/- on one) keeps current "constant expression" semantics — `group by 1 + 0` still produces a constant grouping key, by SQL convention.

## Approach

A new module `packages/quereus/src/planner/building/select-ordinal.ts` exports two helpers:

- `buildSelectListAsts(columns, input)` — builds a source-order array of AST expressions (one per output column, with `*` / `table.*` expanded against the input relation's attributes). This is the lookup table for ordinals.
- `resolveOrdinalReference(expr, selectListAsts, clauseName)` — if `expr` is an integer-literal ordinal (including unary +/- variants), returns the resolved AST expression; out-of-range values throw `QuereusError`. Anything else returns null so the caller falls through to normal `buildExpression`.

`select.ts` now computes `selectListAsts` once, after star expansion, and threads it into:
- `buildAggregatePhase` (used for GROUP BY and the pre-aggregate ORDER BY sort);
- `buildFinalProjections` (pre-projection ORDER BY for non-aggregate queries);
- `applyOrderBy` (early-aggregate, non-aggregate, and aggregate/window paths);
- the inline pre-window sort branch in `select.ts`.

Returning the AST (rather than a pre-built `ScalarPlanNode`) lets each caller re-build the expression in whichever scope is current — important because aggregate ORDER BY runs against the post-aggregate scope where an aggregate AST resolves to a `ColumnReferenceNode` against the AggregateNode output, while GROUP BY runs against the pre-aggregate scope where the same AST would (correctly) be illegal as an aggregate.

## Test cases / use cases for validation

Positive coverage in `packages/quereus/test/logic/07.3-group-by-extras.sqllogic`:
- `select grp, count(*) as cnt from gx group by 1 order by 1;` — single ordinal in both clauses.
- `select grp, sub, sum(val) as total from gx group by 1, 2 order by 1, 2;` — multiple ordinals.
- `select grp, count(*) as cnt from gx group by 1 having count(*) > 2 order by 1;` — HAVING validates against the same group key the ordinal resolves to.
- `select grp, sum(val) as total from gx group by 1 order by 2 desc;` — ORDER BY ordinal `2` resolves to the aggregate output column.

Positive coverage in `packages/quereus/test/logic/28.2-orderby-expression-extras.sqllogic`:
- `select a from ob order by 1;`
- `select c, a from ob order by 1, 2 desc;`
- `select abs(x - 5) as dist from many order by 1;` — ordinal resolves to the alias's expression.

Negative coverage in `packages/quereus/test/logic/90.6-select-error-paths.sqllogic`:
- `select a from eptab group by 0;` — error.
- `select a from eptab group by 2;` (only 1 column) — error.
- `select a from eptab order by -1;` — error (parsed as UnaryExpr).
- `select a from eptab order by 99;` — error.

## Things to check during review

- Star-expanded ordinals: `buildSelectListAsts` constructs synthetic `ColumnExpr` ASTs for `*` columns. There is no specific test for `select * from t order by 1` in the new ticket, but it should work since the synthetic AST resolves like any other column ref. Worth a quick once-over.
- Preserves prior validation: `validateAggregateProjections` continues to use the GROUP BY scalar nodes' attribute IDs; since the ordinal-resolved AST is built in the same pre-aggregate scope as the SELECT projections, attribute IDs match — so `select grp, count(*) from gx group by 1` does not regress to the previous "constant grouping key" failure.
- ORDER BY ordinals in window queries route through the inline pre-window sort branch in `select.ts` — that branch was updated. Sanity-check that the existing window tests still pass (they did in the local run).
- `extractOrdinalValue` accepts unary `+` as well as `-` — `order by +1` resolves to ordinal 1. Matches SQLite. Trivial but worth a glance.

## Build / test status

`yarn build` (full repo) and `yarn test` (`packages/quereus`, 2523 passing / 3 pending) succeed. `yarn lint` in `packages/quereus` succeeds with no warnings.

The companion fix ticket `tickets/fix/1-fix-order-by-positional-reference.md` does not exist in the tree (already absent at start of work) — nothing to delete.
