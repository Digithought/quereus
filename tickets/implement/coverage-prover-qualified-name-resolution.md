description: The coverage prover's ORDER BY / WHERE checks resolve columns by bare name, forcing a conservative name-collision guard that rejects otherwise-valid 1:1 join-body MVs whose lookup side reuses a UC column name. Make the AST checks qualifier-aware so the guard can be dropped.
prereq:
files: packages/quereus/src/planner/analysis/coverage-prover.ts, packages/quereus/src/planner/analysis/predicate-shape.ts (columnIndexFromExpr), packages/quereus/test/covering-structure.spec.ts
----

## Problem

The coverage prover (`coverage-prover.ts`) reads the body's `ORDER BY` and
`WHERE` from the **body AST** (the faithful source of predicate/ordering, since
the optimizer absorbs sargable WHERE into seeks and drops Sorts). Those checks
resolve a column reference to a base-table column index via
`columnIndexFromExpr`, which matches by **bare name** and ignores any
table/alias qualifier (`alias.col` resolves the same as `col`).

For single-source bodies that is fine. For join bodies it is unsafe: a
lookup-side column sharing a name with a UC (or UC-predicate) column would
mis-resolve to T's column, so a sort/filter on the *lookup* column could be
wrongly accepted — a false `Covers`. The multi-source work
(`coverage-prover-multi-source-bodies`) closed the soundness hole with a
**name-collision guard** (`proveJoinOneToOne`) that rejects (`shape`) any join
whose lookup side reuses a UC/UC-predicate column name.

That guard is sound but over-broad. It rejects valid 1:1 join-body MVs whenever
the natural join key happens to be (or share a name with) a UC column. Concrete
example (currently rejected as `shape`, would be valid):

```sql
create table line_items (
  oid integer not null, lineno integer not null, sku text not null,
  primary key (oid, lineno), unique (oid, sku)
);
create table products (sku text primary key, name text);
create materialized view ix as
  select l.oid, l.sku, l.lineno
  from line_items l left join products p on l.sku = p.sku
  order by l.oid, l.sku;   -- 1:1 (products.sku unique) but rejected: `products.sku`
                            -- collides with the UC column `sku`.
```

This is a **completeness** limitation only (never soundness) — but it bites the
common case where the FK/lookup key is also part of the constraint.

## Desired behavior

Make the prover's AST column resolution **qualifier-aware**: when an `ORDER BY` /
`WHERE` term is `alias.col` (or `table.col`), resolve it against the bound source
for that qualifier and only treat it as a base-table T column when the qualifier
actually denotes T's reference (or is unqualified *and* unambiguous). A term that
resolves to a lookup-side column is then handled correctly on its own terms
(an ORDER BY on a lookup column ⇒ `ordering-mismatch`; a WHERE on a lookup column
⇒ `predicate-entailment`) instead of being mis-mapped onto T.

Once resolution is qualifier-aware, the name-collision guard in
`proveJoinOneToOne` becomes unnecessary and should be removed, and the
example above should prove `Covers`.

## Acceptance

- A join body that sorts/filters on a UC-named column qualified to T still
  covers; the same name qualified to the lookup side is rejected for the right
  reason (`ordering-mismatch` / `predicate-entailment`), not `shape`.
- The `line_items ⋈ products on l.sku = p.sku` example proves `Covers`.
- The existing "negative shape: a join on a UC column whose lookup side reuses
  that column name" test is updated to reflect the new (covering) outcome.
- No regression in the single-source suites or the multi-source soundness cases
  (fanout, T-on-dropping-side, self-join, lookup-WHERE rejection).
