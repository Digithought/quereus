---
description: Review property-suite coverage extension for QueryExpr at every accepting AST site. `packages/quereus/test/emit-roundtrip-property.spec.ts` now drives `queryExprArb` (SELECT | VALUES) through five wrapper arbitraries — SubqueryExpr column, InExpr WHERE (both polarities), ExistsExpr WHERE, SelectStmt compound leg, and CommonTableExpr body — so a silent emitter drop at any one of those dispatch sites surfaces structurally, not just at CREATE VIEW.
prereq: dml-in-expression-position
files:
  - packages/quereus/test/emit-roundtrip-property.spec.ts
---

## Summary

Before this ticket, only `createViewArb` drove the (SELECT | VALUES)
union through the round-trip property test; every other QueryExpr-accepting
site (`SubqueryExpr.query`, `InExpr.subquery`, `ExistsExpr.subquery`,
`SelectStmt.compound[].select`, `CommonTableExpr.query`) drove only
`simpleSelectArb`. A regression that dropped a VALUES branch at one of
those emitter dispatches would compile, lint, and continue to pass the
existing property suite — only the `.sqllogic` execution corpus would
catch it, and only for a specific input shape.

This ticket adds one wrapper arbitrary per site and one `it()` per
wrapper, all gated through the existing `checkRoundTrip` driver and
`assertAstEquivalent` comparator.

## What changed

`packages/quereus/test/emit-roundtrip-property.spec.ts` only. Five new
arbitraries and one new `describe` block:

- `subqueryInColumnArb` — `select (<query-expr>) from <t>`. Drives
  `SubqueryExpr.query` in scalar-column position.
- `inSubqueryArb` — `select <c> from <t> where <c> [not] in (<query-expr>)`.
  Drives `InExpr.subquery` for both polarities; the `not`-wrapped form
  emits as `not c in (...)` which the parser folds to
  `UnaryExpr(NOT, InExpr)` — same shape as the `c NOT IN (...)` surface,
  so both branches share an AST.
- `existsSubqueryArb` — `select <c> from <t> where exists (<query-expr>)`.
  Drives `ExistsExpr.subquery`.
- `compoundSelectArb` — `select <c> from <t> <op> <query-expr>` for all
  five ops (`union`, `unionAll`, `intersect`, `except`, `diff`). Drives
  `SelectStmt.compound[].select`.
- `cteSelectArb` — `with <name> as (<query-expr>) select <c> from <t>`.
  Drives `CommonTableExpr.query`. Omits `materializationHint` and the
  CTE column list (see "Known gaps" below).

Each wrapper assembles a top-level `SelectStmt` with the QueryExpr
embedded at the site of interest and hands the whole tree to
`checkRoundTrip`, which delegates structural comparison to
`assertAstEquivalent` (already tolerant of the documented
default-equivalences and case-insensitive identifier folding).

The new `describe` block sits between the existing DDL block and the
transactional block (`AST round-trip property: QueryExpr at every
accepting site`), runs `numRuns: 100` per arbitrary, and reuses the
existing `simpleSelectArb` / `valuesStmtArb` / `queryExprArb` building
blocks unmodified.

## Tests added

Five new `it()` cases, all passing:

```
  AST round-trip property: QueryExpr at every accepting site
    ✔ scalar SubqueryExpr in a SELECT column round-trips structurally
    ✔ InExpr.subquery in WHERE round-trips structurally
    ✔ ExistsExpr.subquery in WHERE round-trips structurally
    ✔ SelectStmt.compound leg round-trips structurally
    ✔ CommonTableExpr.query body round-trips structurally
```

## Validation run

- `yarn lint` (in `packages/quereus`) — clean, exit 0.
- `yarn typecheck` (in `packages/quereus`) — clean, exit 0.
- `node packages/quereus/test-runner.mjs --grep "QueryExpr at every accepting site"`
  — 5 passing.
- `node packages/quereus/test-runner.mjs` (full quereus suite) — 3679
  passing, 9 pending, no failures.

`yarn test:store` was not run — this ticket only touches a test file
that exercises pure parser↔stringifier round-trip (no vtab module
behavior), so the store-backed run would not exercise any of the changed
code.

## Manual regression sanity (no in-tree mutation, walk-through only)

If a future patch broke `ast-stringify.ts:425` (compound leg) by
substituting `selectToString(stmt.compound.select)` for
`astToString(stmt.compound.select)`, the new `compoundSelectArb` test
would fail on any shrunk input that picks `valuesStmtArb` as the right
leg (the `selectToString` branch would drop the `type` discriminator
check and emit ill-formed compound SQL). The same logic applies to
`expressionToString` lines 216 (SubqueryExpr), 219 (ExistsExpr), 227
(InExpr), and `withClauseToString` line 450 (CTE).

## Known gaps for the reviewer

The reviewer should treat this as a floor, not a finish line. Specific
soft spots:

1. **DML at these sites is deliberately uncovered.** The ticket pinned
   this as out-of-scope (the planner gates DML at most of these sites,
   and the property suite is meant for *structural* round-trip, not
   execution). Extending `queryExprArb` to include `insertArb` /
   `updateArb` / `deleteArb` (the latter three already exist in the
   file) would in principle catch DML-branch drops at these sites too,
   but each of those statements would need a RETURNING clause to land
   in a non-top-level position. Filing as a follow-up backlog item is
   the right call if the reviewer agrees with the scope line; mention
   in the complete summary either way.

2. **`materializationHint` on CTEs is dropped by the emitter today.**
   `withClauseToString` (ast-stringify.ts:445-452) emits
   `as (${astToString(cte.query)})` with no `[NOT] MATERIALIZED`
   keyword. The new `cteSelectArb` deliberately leaves the hint unset
   to avoid mixing two failure modes — a separate ticket for either
   (a) wiring up the hint emit or (b) updating the comparator to treat
   it as a known drop would be in order. Filing a backlog ticket is
   appropriate; I did not file one as part of this ticket.

3. **CTE column list is omitted.** Same arity-coupling reason as the
   existing CREATE VIEW arbitrary's VALUES branch. Column-list survival
   at CTEs is unverified by the property suite; the existing
   `emit-roundtrip.spec.ts` covers one canonical case. A separate
   targeted property generator (matching column list to QueryExpr
   width) could close that gap.

4. **Compound chains of length > 1 are not exercised.** Only one
   compound leg is generated per arbitrary; deeper chains
   (`A UNION B UNION C`) would exercise the parser's right-recursive
   compound continuation. Out of scope for this ticket but a logical
   next-step generator.

5. **The wrapper SELECTs are all minimal** — single-column projection
   over a single bare table source. We are not stressing interactions
   between the embedded QueryExpr and outer-SELECT features (correlated
   column refs into the outer, ORDER BY / LIMIT trailing the embedded
   form, etc.). Most of these would also pull in a separate set of
   shape decisions that this ticket left out by design.

## Acceptance criteria the reviewer can recheck

- All 5 new tests are in the new `describe` block and pass at
  `numRuns: 100` each.
- No changes outside `packages/quereus/test/emit-roundtrip-property.spec.ts`.
- The existing CREATE VIEW property test still passes (no incidental
  regression to the existing wrapper).
- `yarn lint`, `yarn typecheck`, and the full quereus test suite are
  green.
