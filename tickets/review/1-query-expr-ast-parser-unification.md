---
description: Review the QueryExpr AST + parser unification — orthogonal acceptance of SELECT / VALUES / DML-w/-RETURNING at every relation site. Build + lint + full test suite green. Read the original implement ticket for the design rationale; this handoff focuses on what shipped, what to verify, and what was deliberately deferred.
prereq:
files:
  - packages/quereus/src/parser/ast.ts
  - packages/quereus/src/parser/parser.ts
  - packages/quereus/src/parser/visitor.ts
  - packages/quereus/src/emit/ast-stringify.ts
  - packages/quereus/src/schema/rename-rewriter.ts
  - packages/quereus/src/schema/view.ts
  - packages/quereus/src/util/mutation-statement.ts
  - packages/quereus/src/runtime/emit/alter-table.ts
  - packages/quereus/src/planner/nodes/create-view-node.ts
  - packages/quereus/src/planner/analysis/assertion-classifier.ts
  - packages/quereus/src/planner/building/insert.ts
  - packages/quereus/src/planner/building/select.ts
  - packages/quereus/src/planner/building/select-compound.ts
  - packages/quereus/src/planner/building/with.ts
  - packages/quereus/src/planner/building/create-view.ts
  - packages/quereus/src/planner/building/expression.ts
  - packages/quereus/test/logic/01.9-query-expr-values.sqllogic
  - packages/quereus/test/logic/01.9-query-expr-dml-gates.sqllogic
  - packages/quereus/test/logic/01.7-update-from.sqllogic
  - packages/quereus/test/logic/13.4-cte-extras.sqllogic
  - packages/quereus/test/logic/28.1-compound-limit-offset.sqllogic
  - packages/quereus/test/logic/03.4.1-default-edge-cases.sqllogic
  - packages/quereus/test/logic/47.1-upsert-conflict-targets.sqllogic
  - packages/quereus/test/logic/44-orthogonality.sqllogic
  - packages/quereus/test/logic/90.4-dml-errors.sqllogic
  - packages/quereus/test/emit-roundtrip-property.spec.ts
  - packages/quereus/test/emit/ast-stringify.spec.ts
  - packages/quereus/test/emit-missing-types.spec.ts
  - docs/sql.md
  - docs/architecture.md
---

## What landed

### AST surface (`packages/quereus/src/parser/ast.ts`)

- New `QueryExpr` union: `SelectStmt | ValuesStmt | InsertStmt | UpdateStmt | DeleteStmt`. Placed after `ValuesStmt`.
- `'mutatingSubquerySource'` discriminant **removed** from `AstNode.type`. `MutatingSubquerySource` interface removed; `SubquerySource.subquery` widened to `QueryExpr`. `FromClause` no longer mentions `MutatingSubquerySource`.
- `InsertStmt.{values, select}` collapsed into a single `source: QueryExpr`. Every constructor and reader updated.
- Widened to `QueryExpr`: `SubqueryExpr.query`, `ExistsExpr.subquery`, `InExpr.subquery`, `SelectStmt.compound[].select`, `CommonTableExpr.query`, `CreateViewStmt.select`.

### Parser (`packages/quereus/src/parser/parser.ts`)

- New `parseQueryExpr(outerWithContext?, requireReturning)` helper. Handles inner-body WITH attachment, dispatches on the leading keyword (`SELECT | VALUES | INSERT | UPDATE | DELETE`), and enforces the RETURNING-required rule for DML in non-top-level positions.
- New `checkSubqueryStart()` helper used at sites that have already consumed `(` to disambiguate subquery vs parenthesized scalar.
- New `valuesStatementWithOptionalCompound()` + `continueSelectAfterFrom()` pair. Top-level (and parseQueryExpr) `VALUES` followed by a compound (`UNION [ALL]` / `INTERSECT` / `EXCEPT` / `DIFF`) synthesizes a `SELECT * FROM (VALUES …) AS <synth>` wrapper so the existing compound machinery applies without needing a new AST node. `VALUES … ORDER BY … LIMIT …` is also picked up here. Compound-leg parser inside `selectStatement` still calls the bare `valuesStatement` to preserve left-associativity of the compound chain.
- Call sites switched to `parseQueryExpr` / the new helpers: CTE body, `INSERT … <source>`, FROM-clause subquery (`tableSource` / `subquerySource` — the legacy `mutatingSubquerySource` method is deleted), scalar / row subquery (`primary`), `EXISTS`, `IN` / `NOT IN`, compound-leg right side (SELECT legs keep `isCompoundSubquery=true` so ORDER BY/LIMIT belong to the outer compound; VALUES and DML legs route through `parseQueryExpr`), `CREATE VIEW` body, declared-schema `VIEW` body.

### Visitor / emitter / rewriter

- `parser/visitor.ts`: `'mutatingSubquerySource'` case dropped; `'insert'` walks `stmt.source`.
- `emit/ast-stringify.ts`: `fromClauseToString` handles `subquerySource` uniformly via `astToString`. `insertToString` emits `stmt.source` via `astToString`. `selectToString.compound`, `subquery`/`exists`/`in` expressions, `createViewToString`, `declaredViewToString` all route through `astToString` so DML bodies serialize correctly. `selectToString(view.selectAst)` in `runtime/emit/alter-table.ts` swapped to `astToString`.
- `schema/rename-rewriter.ts`: `'mutatingSubquerySource'` cases removed in both `visitTableRename` and `visitColumnRename`; `'insert'` walks `source`.
- `util/mutation-statement.ts`: rebuilt INSERT AST with `source: { type: 'values', … }`.

### Planner builders

- `planner/building/insert.ts`: dispatches on `stmt.source.type` (`select` / `values` / DML). DML branch throws a clear UNSUPPORTED error citing the follow-up `dml-in-expression-position` ticket.
- `planner/building/select.ts` (`buildFrom`): `subquerySource` case dispatches on the inner type — SELECT and VALUES build read-only; INSERT / UPDATE / DELETE re-use `buildInsertStmt` / `buildUpdateStmt` / `buildDeleteStmt`, preserving the historical MutatingSubquerySource semantics. View body builder dispatches SELECT/VALUES; DML bodies UNSUPPORTED.
- `planner/building/with.ts`: CTE body dispatches SELECT/VALUES; DML bodies UNSUPPORTED. Recursive CTE rejects non-SELECT recursive legs.
- `planner/building/select-compound.ts`: right leg dispatches SELECT (strips ORDER/LIMIT) / VALUES (direct) / DML (UNSUPPORTED).
- `planner/building/create-view.ts`: gate runs `planViewBody` even when no explicit column list, so DML view bodies fail at CREATE VIEW plan time, not at first reference.
- `planner/building/expression.ts`: new `buildExpressionPositionQueryExpr` helper used by `subquery`/`in`/`exists` cases. SELECT/VALUES build; DML UNSUPPORTED.
- `planner/nodes/create-view-node.ts`: `selectStmt: AST.QueryExpr`.
- `planner/analysis/assertion-classifier.ts`: classifier bails out when the EXISTS subquery body is not a SELECT (was previously typed as SelectStmt; now typed as QueryExpr).
- `schema/view.ts`: `selectAst: AST.QueryExpr` with a comment explaining the gate.

### Tests + docs

New / updated `*.sqllogic` files:

- `01.9-query-expr-values.sqllogic` — positive cases for VALUES bodies at every relation site (CTE, top-level compound, mixed compound, view body unnamed + binding-site columns, IN, EXISTS, scalar subquery).
- `01.9-query-expr-dml-gates.sqllogic` — negative cases for the parser-side RETURNING-required gate and the planner-side DML-in-expression-position gate.
- `13.4-cte-extras.sqllogic` — flipped two cases (`VALUES in CTE body` and `nested WITH inside CTE body`) from expected-error to expected-result. They were documenting old limitations the unification fixes.
- `28.1-compound-limit-offset.sqllogic` — flipped `VALUES UNION VALUES` from expected-error to expected-result, pinning the new behaviour and the `column_0`/`column_1` synthesized naming convention.
- `01.7-update-from.sqllogic`, `03.4.1-default-edge-cases.sqllogic`, `47.1-upsert-conflict-targets.sqllogic`, `44-orthogonality.sqllogic`, `90.4-dml-errors.sqllogic` — adjusted error-string substring expectations to match the new parser messages. None of these tests' intent changed.

Spec / unit tests:

- `test/emit-roundtrip-property.spec.ts` — added a `valuesStmtArb` and a `queryExprArb` and wired `createViewArb` to use it. The CREATE VIEW round-trip suite now structurally generates VALUES-bodied views and verifies they survive `parse → stringify → parse`. The INSERT smoke test uses the new `source: { type: 'values', … }` shape.
- `test/emit/ast-stringify.spec.ts` — narrowed compound walk via `body.type === 'select'`; updated the InsertStmt literal-build helper to the new shape.
- `test/emit-missing-types.spec.ts` — replaced the `MutatingSubquerySource` import + test with a `SubquerySource` carrying a DML body, asserting the unified shape emits correctly.

Docs:

- `docs/sql.md` — new "Query expressions" subsection at the top of section 2 with a form table, site list, RETURNING-required rule, planner gate note, and the column-naming precedence table.
- `docs/architecture.md` — new "Orthogonal Query Expressions" bullet in the architecture key-features list, citing the SQL doc and the follow-up ticket.

## Validation done

From the package root (`packages/quereus`):
- `yarn run build` — passes.
- `yarn run lint` — passes.
- `yarn run test` — full quereus suite passes (mocha + the `*.sqllogic` corpus).

From the repo root:
- `yarn test` — all workspaces green.

`yarn test:store` and `yarn test:full` not run (per the repo's "default to memory-vtab" testing guidance and the ticket's not-a-store-issue scope). The implementer's hunch is the store path should be unaffected since the AST changes are upstream of vtab dispatch, but the reviewer may want to confirm.

## What to look at hardest

1. **`valuesStatementWithOptionalCompound` + `continueSelectAfterFrom`** in `parser/parser.ts`. This is the only place the unification couldn't be a straight mechanical refactor — `compound` lives on `SelectStmt` rather than `QueryExpr`, so top-level `VALUES UNION VALUES` is implemented by synthesizing a `SELECT * FROM (VALUES …)` wrapper. Concerns to probe: does the synthetic alias collide with anything the user could have written; do `WHERE` / `GROUP BY` / `HAVING` on the wrapper interact correctly with `compound` (the implementer threaded them through but didn't grow a logic test for the corner); does the right-leg dispatch handle a parenthesized form correctly when the left was a synthetic VALUES wrapper.
2. **Planning-time DML gate placement.** The gate fires at six sites (SubqueryExpr, ExistsExpr, InExpr, compound leg, view body, non-top CTE body) but **not** in INSERT-source position — DML in INSERT source is rejected by `insert.ts` itself with the same error class. The reviewer should sanity-check the error message is consistent across sites and that the gate doesn't double-fire.
3. **AST round-trip property suite coverage.** The implementer added VALUES bodies to `createViewArb`. The suite only structurally generates DDL today — the new five-form-everywhere surface is not stress-tested at IN / EXISTS / scalar-subquery / compound-leg / CTE-body sites by the property suite. The new `*.sqllogic` files pin those positively but the round-trip property test is the catch for "stringifier silently drops a field". A reviewer may want to extend `queryExprArb` to those sites too — the implementer judged this out of scope for the ticket but flags it as a coverage gap.
4. **Recursive CTE base-case extraction.** `with.ts` builds `baseCaseStmt: AST.SelectStmt = { ...selectStmt, compound: undefined, … }`. The recursive-leg type guard now lives a few lines later and explicitly throws on non-SELECT recursive legs. Confirm the existing recursive CTE tests still cover the happy path — they did pass in this run, but the type-narrowing is subtle.
5. **Top-level VALUES round-trip.** The synthesized SELECT-from-(VALUES) wrapper means `astToString(parse('values (1) union all values (2)'))` emits a SELECT-shape, not a bare `values … union all values …`. That's a behavior change for the emitter. The AST round-trip property test doesn't currently generate top-level compound VALUES so this isn't covered there; the new `01.9-query-expr-values.sqllogic` pins the execution path but not the emitted-string shape. If the reviewer cares about preserving the bare-VALUES emitter form, that's a follow-up — the implementer chose the pragmatic shape over a new AST node.

## Out of scope (per the ticket)

- The `hasSideEffects` audit, optimizer-rule audit, runtime-emitter changes — `query-expr-side-effect-audit`.
- Lifting the planning-time DML-in-expression-position gate (full-drain semantics, run-once fence, change-scope propagation, view-body rejection) — `dml-in-expression-position`.
- Parallel-track refusal of impure branches — `query-expr-parallel-track-refusal`.
- One-indexed `column1` synthesized naming — backlog if desired.
- `TABLE t` shorthand and lateral `VALUES` cases — backlog.

## Known gaps the reviewer should treat as a starting point, not a finish line

- The AST round-trip property suite extension is **minimal** — `createViewArb` produces VALUES bodies, but IN / EXISTS / scalar-subquery / compound-leg / CTE-body sites are not driven by the property suite. The `*.sqllogic` corpus pins them at the execution level, which is a different (and arguably stronger) guarantee, but a missed emitter drop at one of those sites would not surface through fast-check.
- The store-suite (`yarn test:store`) was not run. The change set should be store-agnostic, but the reviewer can request a run if there's any uncertainty.
- One synthesized-alias name (`values_<offset>` / `subquery_<offset>` / `mutating_subquery_<offset>`) is exposed in error messages and could in principle collide with a user table named exactly that. Pre-existing pattern (the legacy `mutatingSubquerySource` parser used the same scheme), but worth a glance.
