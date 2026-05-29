description: Let the covering-structure coverage prover admit an INNER (or CROSS-with-equi) join body as covering a single-table UNIQUE constraint when referential integrity proves the join loses no rows of the constrained table — extending the LEFT/RIGHT-outer admit path from `coverage-prover-multi-source-bodies`.
prereq: coverage-prover-multi-source-bodies
files: packages/quereus/src/planner/analysis/coverage-prover.ts, packages/quereus/src/planner/util/key-utils.ts
----

## Motivation

`coverage-prover-multi-source-bodies` admits a join MV as covering `unique(...)` on a
base table `T` only when `T` is on the **preserving** side of a LEFT/RIGHT outer join
(row-preservation), gated by a fan-out check (`isUnique(T.pk-on-output, root)`).

The most natural lookup join users actually write is an **inner** join:

```sql
create materialized view ix as
  select o.customer_id, o.sku, o.id
  from orders o join customers c on o.customer_id = c.id   -- inner
  order by o.customer_id, o.sku;
```

An inner join is sound for covering **iff every `T` row provably matches** (so no
governed `T` row is dropped from the MV). That holds when the join is on a NOT NULL
foreign key from `T` to the lookup table's primary/unique key, *and* referential
integrity is enforced for that FK.

## Scope

- Admit an inner/cross-equi join body when `T`'s rows are provably retained:
  - the equi-pairs form a NOT NULL FK from `T` to the other side's PK/unique key
    (`checkFkPkAlignment` in `key-utils.ts` is the existing FK↔equi-pair alignment
    seam), **and**
  - the engine actually enforces referential integrity for that FK (confirm
    Quereus' FK-enforcement guarantees; if FKs are advisory/unenforced, this admit
    path is unsound and must stay rejected).
- Compose with the existing fan-out gate (`isUnique`) and all v1 checks unchanged.

## Soundness

Row loss is the only gap inner joins have versus the outer-join admit path. The FK +
NOT NULL + enforced-RI triple closes it: every `T` row has exactly one matching
lookup row, so the inner join is 1:1. If any leg is unprovable (nullable FK,
unenforced RI, non-FK equi-join), reject — a false `Covers` would let the MV miss
conflicts among dropped `T` rows.

## Relationship

Direct follow-up to `coverage-prover-multi-source-bodies` (outer-join admit path).
Distinct from `lens-multi-source-decomposition` (logical-table decomposition across
basis tables).
