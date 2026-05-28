---
description: Introduce QueryExpr AST union and accept it uniformly at every relation site in the parser. Mechanical refactor; DML in expression position parses but errors at planning time (lifted by later tickets).
prereq:
files:
  - packages/quereus/src/parser/ast.ts
  - packages/quereus/src/parser/parser.ts
  - packages/quereus/src/parser/visitor.ts
  - packages/quereus/src/emit/ast-stringify.ts
  - packages/quereus/src/schema/rename-rewriter.ts
  - packages/quereus/src/planner/building/select.ts
  - packages/quereus/src/planner/building/insert.ts
  - packages/quereus/src/planner/building/block.ts
  - docs/sql.md
  - docs/architecture.md
---

## Goal

Land the AST + parser half of the Relational Orthogonality plan. Every site that today accepts only `SelectStmt` (or `SelectStmt | ValuesStmt`) widens to accept any relation-producing statement. No new runtime/optimizer behavior — DML in expression position parses but errors cleanly at planning time. Later tickets (`query-expr-side-effect-audit`, `dml-in-expression-position`, `query-expr-parallel-track-refusal`) lift that gate.

Background, semantics, naming policy, and the full site-by-site table live in `tickets/complete/` (or wherever this plan was archived) — read alongside this ticket.

## AST shape

```ts
export type QueryExpr =
  | SelectStmt
  | ValuesStmt
  | InsertStmt   // RETURNING required outside top-level
  | UpdateStmt   // RETURNING required outside top-level
  | DeleteStmt;  // RETURNING required outside top-level
```

`MutatingSubquerySource` is folded into `SubquerySource` (whose `subquery` field widens to `QueryExpr`). The discriminant tag `'mutatingSubquerySource'` is removed from `AstNode.type`. The `'subquerySource'` builder branches on the inner statement type, not on the source-wrapper tag.

`InsertStmt` drops the parallel `values?: Expression[][]` / `select?: SelectStmt` fields in favor of a single `source: QueryExpr`. A bare `VALUES` row list becomes a `ValuesStmt` like any other.

`CreateViewStmt.select` renames to `body: QueryExpr`. (Or keep `select` as a name but widen the type — implementer's call; the rename is clearer but touches more sites.)

## Parser strategy

A single helper replaces the scattered relation-parsing entry points:

```
parseQueryExpr(startToken?, withClause?):
  if WITH      → consume, recurse with innerWith attached to the inner query
  if SELECT    → selectStatement
  if VALUES    → valuesStatement
  if INSERT    → insertStatement   (caller enforces RETURNING-required)
  if UPDATE    → updateStatement   (caller enforces RETURNING-required)
  if DELETE    → deleteStatement   (caller enforces RETURNING-required)
  else         → error
```

Callers:

- Top-level `statement()` — calls `parseQueryExpr` (or stays specialized; doesn't need RETURNING).
- `INSERT … <source>` (`parser.ts:375-406`) — calls `parseQueryExpr`; no RETURNING requirement (the outer DML is the consumer).
- FROM-clause subquery `(LPAREN, lookahead)` in `tableSource` (`parser.ts:808-820`) — calls `parseQueryExpr`; requires RETURNING when inner is DML.
- `(LPAREN, lookahead)` in `primary` (scalar / row subquery, `parser.ts:1779`) — same.
- `EXISTS (...)` (`parser.ts:1609`) — same.
- `IN (...)` / `NOT IN (...)` subquery (`parser.ts:1277, 1396`) — same.
- Compound legs of `UNION`/`INTERSECT`/`EXCEPT` (`parser.ts:609, 615`) — same; widen `SelectStmt.compound[].select` field accordingly.
- CTE body (`parser.ts:242-263`) — calls `parseQueryExpr`. Closes the explicit `VALUES`-in-CTE TODO at line 260.
- `CREATE VIEW v AS …` — calls `parseQueryExpr`.

## Column naming for unnamed-source bodies

Per the plan's precedence rule:

1. Binding-site column list (view `(col, …)`, CTE `t(col, …)`, FROM `AS t(col, …)`) wins absolutely.
2. Body-supplied names (SELECT aliases/column-refs, RETURNING aliases/column-refs); VALUES has none.
3. Fallback: synthesized `column_0`, `column_1`, … matching today's `ValuesNode` defaults.

Persistent named relations (view bodies, top-level CTE bodies) with no names at either site **silently synthesize**. First action under this ticket: confirm `create view v as select 1, 'a'` already silently synthesizes today — if it errors instead, match the existing behavior rather than introducing a new asymmetry. The rule is "VALUES bodies behave like SELECT-of-unnamed-expressions bodies", not a specific outcome.

## Planning-time gate for DML-in-expression-position

This ticket parses `(insert/update/delete … returning …)` everywhere a relation is allowed but does **not** make it execute correctly in expression position. Add a guard in the planner builder for `SubqueryExpr` / `ExistsExpr` / `InExpr` / compound-leg / view-body / non-top-level CTE sites: when the inner `QueryExpr` is DML, throw a clear "not yet supported" error citing the follow-up ticket. FROM-position DML already works (existing `MutatingSubquerySource` semantics, now reached via the folded `SubquerySource`) — that path stays live.

## Tests

- AST round-trip property test (`test/emit-roundtrip-property.spec.ts`) — extend the generator to emit `QueryExpr` at every site. Assert `parse(stringify(x)) ≡ x`. This is the net that catches stealth field-drops in `ast-stringify` after the `MutatingSubquerySource` fold and the `InsertStmt` field collapse.
- `*.sqllogic` cases that should now parse + execute under the pure-VALUES portion:
  - `with t(a,b) as (values (1,'x'),(2,'y')) select * from t`
  - `values (1) union all values (2)`
  - `select * from (values (1,'x'),(2,'y')) union all values (3,'z')` — compound-leg parity
  - `create view v as values (1,'a'),(2,'b'); select * from v`
  - `create view v(a,b) as values (1,'x'),(2,'y'); select * from v` — binding-site names win
  - VALUES inside `IN`, `EXISTS`, and scalar subquery position — these may already work today via the `Project(Values…)` path; pin with explicit tests anyway.
- Declarative-schema equivalence test gains free coverage of `values`-bodied views.
- Negative tests for the planning-time gate: `(insert … returning …)` in every expression position errors with the agreed message (not a parser surprise, not a runtime crash).
- Negative test: `(insert … )` (no RETURNING) in non-top-level position errors at parse time.

## Documentation

- `docs/sql.md` — replace the "VALUES is usually part of SELECT" framing with a short "Query expressions" section listing the five forms and the sites that accept them. Note the pure-VALUES portion is live now; DML-in-expression-position is gated pending follow-up.
- `docs/architecture.md` — the orthogonality bullet graduates from aspirational to literal-for-VALUES; mention DML-in-expression-position is the next milestone.

## Out of scope

- `hasSideEffects` audit, optimizer rule audit, runtime emitter changes — ticket `query-expr-side-effect-audit`.
- Lifting the planning-time DML-in-expression-position gate, full-drain semantics, run-once fence, `getChangeScope` propagation, view-body rejection — ticket `dml-in-expression-position`.
- Parallel-track refusal of impure branches — ticket `query-expr-parallel-track-refusal`.
- One-indexed `column1` synthesized naming — separate backlog ticket if desired.
- `TABLE t` shorthand and lateral `VALUES` cases — backlog.

## TODO

### Phase 1 — AST surface

- Add `QueryExpr` union to `parser/ast.ts`.
- Fold `MutatingSubquerySource` into `SubquerySource`; remove the `'mutatingSubquerySource'` discriminant from `AstNode.type` and every site that reads it.
- Collapse `InsertStmt.{values, select}` → `InsertStmt.source: QueryExpr`. Adjust any AST builders/factories that construct `InsertStmt` literals (tests, the schema-declaration path, the rename rewriter).
- Widen `SubqueryExpr.query`, `ExistsExpr.subquery`, `InExpr.subquery`, `SelectStmt.compound[].select`, `commonTableExpr.body`, `CreateViewStmt.{select|body}` to `QueryExpr`.
- Update `parser/visitor.ts` to walk the unified shape — the `MutatingSubquerySource` visit case folds into the `SubquerySource` case; the `InsertStmt` case walks `source` instead of `values | select`.
- Update `emit/ast-stringify.ts` for all of the above; this is the canary that the round-trip test will catch if missed.
- Update `schema/rename-rewriter.ts` for all of the above.

### Phase 2 — Parser

- Implement `parseQueryExpr(startToken?, withClause?)`.
- Replace every relation-parsing call site listed under "Parser strategy" above.
- Enforce RETURNING-required at non-top-level call sites.
- Run parser unit tests + the AST round-trip property test.

### Phase 3 — Planner builders

- Update `planner/building/insert.ts` to dispatch on `InsertStmt.source` (`SelectStmt`/`ValuesStmt`/DML-with-RETURNING) via a single `buildQueryExpr` call into the existing DML pipeline. The pure-VALUES legacy path can collapse.
- Update `planner/building/select.ts` `subquerySource` builder (currently around lines 455-493) to handle the folded `SubquerySource` shape; the existing `MutatingSubquerySource` branch behavior is the right behavior — just enter it based on the inner statement type.
- Add the planning-time DML-in-expression-position gate (see above).
- CTE-body builder (`planner/building/block.ts` or wherever `commonTableExpr` lowers): handle `ValuesStmt` body — should already work via the folded path; pin with a test.

### Phase 4 — Tests + docs

- AST round-trip property test extension.
- New `*.sqllogic` cases.
- Negative tests for the planning-time DML gate and RETURNING-required-outside-top-level rule.
- Docs touch-ups per "Documentation" above.

### Validation

- `yarn workspace @quereus/quereus run lint`
- `yarn test` (root)
- AST round-trip property test must pass; logic-test corpus must show no regressions.
