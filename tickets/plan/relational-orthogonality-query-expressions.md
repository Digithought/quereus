---
description: Make VALUES (and DML-with-RETURNING) usable anywhere a SELECT can appear; unify under a single `QueryExpr` AST surface.
files:
  - packages/quereus/src/parser/ast.ts
  - packages/quereus/src/parser/parser.ts
  - packages/quereus/src/planner/building/select.ts
  - packages/quereus/src/planner/building/block.ts
  - packages/quereus/src/emit/ast-stringify.ts
  - packages/quereus/src/schema/rename-rewriter.ts
  - packages/quereus/src/parser/visitor.ts
  - docs/architecture.md
  - docs/sql.md
---

## Background

`docs/architecture.md` lists **Relational Orthogonality** as a design tenet:

> any statement that results in a relation can be used anywhere that expects a relation value, including mutating statements with RETURNING clauses.

The parser today only partially honors this. Three forms produce a relation — `SELECT`, `VALUES`, and DML-with-`RETURNING` — but each one is wired in by hand at every site, and the table is sparse:

| Context | `SELECT` | `VALUES` | `INSERT/UPDATE/DELETE RETURNING` |
|---|---|---|---|
| Top-level statement | ✅ | ✅ | ✅ |
| `INSERT ... <source>` | ✅ | ✅ (parallel AST field) | ❌ |
| FROM-clause subquery `(...) AS t` | ✅ | ✅ | ✅ (`MutatingSubquerySource`) |
| CTE body `WITH t AS (...)` | ✅ | ❌ (parser TODO `parser.ts:260`) | ✅ |
| Scalar / row subquery `(...)` in expression | ✅ (`parser.ts:1779`) | ❌ | ❌ |
| `EXISTS (...)` | ✅ (`parser.ts:1609`) | ❌ | ❌ |
| `IN (...)` / `NOT IN (...)` subquery | ✅ (`parser.ts:1277, 1396`) | ❌ | ❌ |
| Compound leg (`UNION` / `INTERSECT` / `EXCEPT`) | ✅ (`parser.ts:609, 615`) | ❌ | ❌ |
| `CREATE VIEW v AS ...` | ✅ (`AST.CreateViewStmt.select`) | ❌ | n/a |

Every ❌ above is a parser-only artifact. The planner already treats `ValuesStmt` and DML-with-RETURNING as ordinary `RelationalPlanNode`s — `buildFrom`'s `subquerySource` branch (`building/select.ts:455-493`) handles both paths interchangeably, and `buildValuesStmt` (`building/select.ts:291`) returns the same node shape `buildSelectStmt` does.

## Goal

Introduce a single AST surface — call it `QueryExpr` — covering everything that yields a relation, and accept it uniformly at every relation site. This is a structural refactor of the AST + parser; the planner, optimizer, and runtime are largely unchanged because they already operate on `RelationalPlanNode`.

## AST shape

```ts
// New union; replaces every ad-hoc `SelectStmt | ValuesStmt | ...` site.
export type QueryExpr =
  | SelectStmt
  | ValuesStmt
  | InsertStmt   // must have `returning`
  | UpdateStmt   // must have `returning`
  | DeleteStmt;  // must have `returning`
```

Site-by-site impact:

- **`InsertStmt`** — replace the parallel `values?: Expression[][]; select?: SelectStmt` fields with `source: QueryExpr`. `parser.ts:375-406` collapses to one dispatch. `building/insert.ts` (wherever it currently branches on `values` vs `select`) collapses to a single `buildQueryExpr(source)` call feeding the DML pipeline. `ast-stringify.ts` and `rename-rewriter.ts` lose their dual paths.
- **`SubquerySource.subquery`** — widen from `SelectStmt | ValuesStmt` to `QueryExpr`. `MutatingSubquerySource` then becomes redundant; fold it into `SubquerySource`. Parser's FROM-source dispatch (`parser.ts:808-820`) loses its `SELECT|VALUES|WITH` vs `INSERT|UPDATE|DELETE` split.
- **`SubqueryExpr`** (scalar / row, `parser.ts:1776-1794`), **`ExistsExpr`** (`parser.ts:1605-1616`), **`InExpr.subquery`** (`parser.ts:1273-1296, 1392-1408`) — all widen from `SelectStmt` to `QueryExpr`. The lookahead inside `(` accepts `SELECT`, `VALUES`, `WITH`, `INSERT`, `UPDATE`, `DELETE`.
- **Compound legs** (`SelectStmt.compound`, `parser.ts:609, 615`) — widen so `values (1) union all values (2)` and `select … union all (insert … returning …)` parse. The compound-result node is already relational-only, so semantics are unaffected.
- **CTE body** (`parser.ts:242-263`) — accept `VALUES` (closing the explicit TODO at line 260). `INSERT/UPDATE/DELETE` already work.
- **`CreateViewStmt.select`** → `body: QueryExpr`. `create view v as values (1,'a'),(2,'b')` becomes valid. View-updateability (see `docs/view-updateability.md`) is already FD-driven and operates on the planner-side relation, so no semantic change.

## Mutating sources in expression position — semantics

`(insert into t values (...) returning id) in (...)` is the spicy case. Two questions to settle in this ticket, with proposed defaults:

1. **Execution order / cardinality.** Mutating subqueries are *not* idempotent. Proposal: a mutating subquery in expression position is executed **once per evaluation**, identical to its FROM-position behavior today. The planner already enforces this via the `Sink`/`MutatingSubquerySource` distinction; widening the parser does not relax it.

2. **Allowed positions.** Proposal: permitted in scalar/row subquery, `EXISTS`, `IN`, compound legs, CTE bodies, and view bodies. **Disallowed** in `CHECK`/`DEFAULT`/assertion expressions (already gated by the determinism enforcer — see `docs/runtime.md#determinism-validation` — the existing check should catch DML naturally, but verify). Disallow inside expressions evaluated as part of *another* DML's per-row context (e.g. `update t set x = (insert into u ... returning y)`) for v1 — listing as a `backlog/` follow-up keeps this ticket scoped.

## Parser strategy

A single helper `parseQueryExpr(startToken?, withClause?)` replaces the scattered `selectStatement` / `valuesStatement` / `mutatingSubquerySource` calls at every relation site:

```
parseQueryExpr:
  if WITH      → consume, recurse with innerWith attached to the inner query
  if SELECT    → selectStatement
  if VALUES    → valuesStatement
  if INSERT    → insertStatement   (require RETURNING when used non-top-level)
  if UPDATE    → updateStatement   (require RETURNING when used non-top-level)
  if DELETE    → deleteStatement   (require RETURNING when used non-top-level)
  else error
```

The `(LPAREN, lookahead)` site at the head of `tableSource` / `primary` / `EXISTS` / `IN` all delegate here. The "RETURNING required outside top level" check lives on the caller side (top-level `statement()` skips it; every nested site enforces).

## Out of scope (parked separately)

- DML inside expressions evaluated per row of an outer DML (`update t set x = (insert … returning …)`) — needs ordering semantics review.
- `TABLE t` SQL-standard shorthand for `SELECT * FROM t` as a query expression — adjacent but unrelated.
- Lateral `VALUES` referencing outer columns — works as a side effect once parsing is unified, but verify and pin with a test.

## Test surface (informal — flesh out at implement stage)

The win is that one round-trip + one plan-shape sweep covers a large new matrix:

- **AST round-trip property test** (`test/emit-roundtrip-property.spec.ts`) is the natural net: enumerate `QueryExpr` at every site, assert `parse(stringify(x)) ≡ x`. Catches stealth field-drops in `ast-stringify`.
- **Declarative-schema equivalence** (`test/declarative-equivalence.spec.ts`) gains free coverage of `create view v as values …` and DML-RETURNING view bodies once `CreateViewStmt.body: QueryExpr` lands.
- New `*.sqllogic` cases: `with t(a,b) as (values (1,'x'),(2,'y')) select * from t`; `values (1) union all values (2)`; `(values (1),(2)) in (select id from t)`; `exists (values (1))`; `select (insert into log values (default,'hit') returning id)`; `create view v as values (1,'a'),(2,'b')`.
- Plan-shape parity: a SELECT-form and equivalent VALUES-form of the same constant relation should produce isomorphic optimized plans modulo node-type leaf, since both lower to `ValuesNode` vs `Project(Values…)` shapes the optimizer already normalizes.
- Negative tests: `INSERT … RETURNING` in `CHECK` / `DEFAULT` / assertion expressions must error with the existing determinism diagnostic, not a parser surprise.

## Documentation touch points

- `docs/architecture.md` — the orthogonality bullet (line 106) graduates from aspiration to literal truth; mention the unified `QueryExpr` surface.
- `docs/sql.md` — replace the `VALUES is usually part of SELECT` framing throughout; add a short "Query expressions" section listing the five forms and the sites that accept them.

## Risks

- **Ambiguous parses** in expression-position when a mutating keyword appears inside `(`: today `(INSERT …)` in expression position is a syntax error, so widening is purely additive — no existing grammar breaks. Confirm by running the full `*.sqllogic` corpus + parser-robustness property test.
- **AST consumer fanout** — anything that pattern-matches `node.type === 'select'` to mean "is a relation" needs auditing. `rename-rewriter.ts`, `visitor.ts`, `ast-stringify.ts`, and any planner-side AST traversal are the main suspects. The `RelationalPlanNode` boundary downstream already abstracts this.
- **Backwards-compat in `InsertStmt`**: dropping `values` + `select` in favor of `source` is a breaking AST change. Per `AGENTS.md` ("Don't worry about backwards compatibility yet"), that's acceptable; the change is mechanical for any in-tree consumer.

## References

- `docs/architecture.md` §"Key Design Decisions" — Relational Orthogonality
- `docs/view-updateability.md` — confirms view-body refactor is safe (FD-driven, not parse-shape-driven)
- `docs/runtime.md#determinism-validation` — gates DML in CHECK/DEFAULT
- Recent commit `f126ba02 ticket(plan): values-singleton-fd` — `ValuesNode`'s FD surface is current, so the existing constant-table optimizer story is in good shape.
