description: Generalize the covering-structure coverage prover (`planner/analysis/coverage-prover.ts`, landed by `covering-structure-unique-enforcement`) to recognize coverage when the materialized view's *effective key* equals the UNIQUE-constraint columns by functional-dependency closure, rather than by literal projection of those columns. v1 of the prover only accepts a body that literally projects every UC column plus the source PK; this extends it to bodies where the constraint columns are derivable through the FD framework (e.g. a `group by` whose group key functionally determines the UC columns, or a projection of expressions whose FDs close over them).
files: packages/quereus/src/planner/analysis/coverage-prover.ts, packages/quereus/src/planner/util/fd-utils.ts
----

## Scope

The v1 coverage prover is intentionally narrow: a covering MV must literally project every `uc.columns[i]` and every PK column of the source table, with `order by` a permutation of the UC columns. This rejects bodies that *do* cover the constraint but express the key indirectly via functional dependencies.

Use case: a body `select x, y, sum(z) from t group by x, y` has effective key `(x, y)`; if `unique(x, y)` is declared, the body proves/covers it even though the projection's relationship to the constraint is via the group-by FD, not a literal column passthrough. The unified `keysOf` / FD surface already exposes the facts; the prover should *apply* them in the "is the constraint's column set within the body's key closure?" direction.

## Expectations

- A new recognition path: `Covers` when the body's `keysOf` / FD closure subsumes `uc.columns`, even if the projection does not literally list them.
- Soundness: the derived coverage must still support recovering enough to identify the source row (PK reconstructibility), consistent with the v1 PK-projection requirement.
- Must compose with the existing NULL-skip and ordering requirements.

## Relationship

Consumed by `lens-prover-and-constraint-attachment` for the "body proves it" obligation class (a body that proves a logical `unique` needs no enforcement structure). The narrow v1 prover handles literal projections; this widens recognition to FD-derived keys.
