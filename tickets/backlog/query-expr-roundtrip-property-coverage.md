---
description: Extend the AST round-trip property suite (`packages/quereus/test/emit-roundtrip-property.spec.ts`) so `queryExprArb` drives every QueryExpr-accepting site, not just `createViewArb`. Today the round-trip fast-check catches a silent emitter drop only at the CREATE VIEW body; IN / EXISTS / scalar-subquery / compound-leg / non-view-body CTE sites still drive `simpleSelectArb`. The `*.sqllogic` corpus pins those execution paths positively, but a stringifier regression that dropped a VALUES branch (or a DML branch) at one of those sites would not surface through the property suite.
files:
  - packages/quereus/test/emit-roundtrip-property.spec.ts
---

## Background

The `query-expr-ast-parser-unification` ticket widened `SubqueryExpr.query`, `InExpr.subquery`, `ExistsExpr.subquery`, `SelectStmt.compound[].select`, `CommonTableExpr.query`, and `CreateViewStmt.select` to `QueryExpr` (any of SELECT / VALUES / INSERT / UPDATE / DELETE). The emitter (`astToString`) dispatches on the inner discriminator at all of those sites.

The round-trip property suite was extended to drive a `queryExprArb` (currently `SELECT | VALUES`) only at `createViewArb`. The other sites are still wired to `simpleSelectArb`.

## Scope

For each of the remaining QueryExpr-accepting sites, drive the corresponding generator off `queryExprArb` (or a similarly broadened generator) and confirm structural round-trip survival via `parse → stringify → parse`:

- `SubqueryExpr.query` — scalar / row subquery in expression position
- `InExpr.subquery` — `IN (<query-expr>)` and `NOT IN (<query-expr>)`
- `ExistsExpr.subquery` — `EXISTS (<query-expr>)`
- `SelectStmt.compound[].select` — compound legs (UNION / INTERSECT / EXCEPT / DIFF)
- `CommonTableExpr.query` — CTE body (already tolerates VALUES; needs explicit generator coverage)

The point is *structural* survival — the planner gates DML at most of these sites, so the property suite should not actually execute the DML bodies. The round-trip test reads only `parse(emit(parse(sql)))` ≡ `parse(sql)`, which is independent of planning.

## Out of scope

- Extending coverage to DML-bodied QueryExprs (INSERT / UPDATE / DELETE w/ RETURNING) at these sites. The implement ticket added DML to the AST and gated the planner; adding DML to fast-check generators is a logical next step but is its own task.
- Tightening the wrapper-emit shape for top-level `VALUES UNION VALUES` (the synthesized SELECT-from-(VALUES) wrapper is what comes out, not a bare-VALUES form). That's an emitter-shape decision, not a coverage gap.
