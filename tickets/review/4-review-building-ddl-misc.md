description: Systematic review of planner building for DDL, expressions, and misc
dependencies: none
files:
  packages/quereus/src/planner/building/expression.ts
  packages/quereus/src/planner/building/function-call.ts
  packages/quereus/src/planner/building/with.ts
  packages/quereus/src/planner/building/schema-resolution.ts
  packages/quereus/src/planner/building/table.ts
  packages/quereus/src/planner/building/table-function.ts
  packages/quereus/src/planner/building/block.ts
  packages/quereus/src/planner/building/pragma.ts
  packages/quereus/src/planner/building/transaction.ts
  packages/quereus/src/planner/building/analyze.ts
  packages/quereus/src/planner/building/alter-table.ts
  packages/quereus/src/planner/building/create-view.ts
  packages/quereus/src/planner/building/create-assertion.ts
  packages/quereus/src/planner/building/drop-view.ts
  packages/quereus/src/planner/building/drop-table.ts
  packages/quereus/src/planner/building/drop-assertion.ts
  packages/quereus/src/planner/building/declare-schema.ts
  packages/quereus/src/planner/building/ddl.ts
----
Review planner building for DDL, expressions, and miscellaneous statements: expression builder, function call resolution, CTE (WITH) builder, schema resolution, FROM clause table/function resolution, DDL builders (CREATE/DROP/ALTER), and utility statements (PRAGMA, ANALYZE, transactions).

Key areas of concern:
- Expression builder — operator precedence, type inference, null propagation
- Function call — overload resolution, argument type checking
- WITH clause — recursive vs non-recursive detection, name shadowing
- Schema resolution — qualified names, default schema, case sensitivity
- Table resolution — alias handling, self-joins
- ALTER TABLE — column type migration safety
- CREATE VIEW — dependency tracking, column inference
- DDL — IF EXISTS/IF NOT EXISTS correctness

Follow the review protocol in docs/review.md.
Trivial fixes may be applied directly; non-trivial findings become fix/ or plan/ tickets.
