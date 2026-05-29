description: Extend the covering-structure coverage prover (`planner/analysis/coverage-prover.ts`, landed by `covering-structure-unique-enforcement`) to recognize a multi-source (join) materialized-view body as covering a single-table UNIQUE constraint, by virtue of the body advertising a single-source binding through the binding extractor. v1 of the prover restricts the covering body to a linear single-source chain (`TableReference → Filter → Project → Sort` over the constrained table); this admits join bodies whose contribution to the constrained table's key is provably 1:1.
files: packages/quereus/src/planner/analysis/coverage-prover.ts, packages/quereus/src/planner/analysis/binding-extractor.ts
----

## Scope

The v1 coverage prover rejects any body whose source is not a single `TableReference` over the constrained table. A join MV can still cover a single-table UNIQUE constraint when the join is key-preserving for that table — e.g. an equi-join to a lookup table on a foreign key that does not duplicate the constrained table's rows.

The binding extractor's `'row'` classification can in principle establish that the constrained table contributes exactly one MV row per source row (the precondition for the MV to be a faithful covering index). This ticket teaches the prover to consult that binding analysis and accept a multi-source body when the constrained table binds as `'row'` and the join provably does not fan out its rows.

## Expectations

- Recognition path that admits a join body when `extractBindings` classifies the constrained source as `'row'` with a 1:1 contribution.
- Soundness: a join that fans out (1:N) the constrained table's rows must be rejected — the MV would then carry duplicate UC keys that do not reflect source duplicates.
- Composes with NULL-skip, ordering, and PK-projection requirements from v1.

## Relationship

Distinct from `lens-multi-source-decomposition` (which is about logical-table decomposition across multiple basis tables). This is narrowly about the *enforcement-coverage* prover recognizing a join MV as a valid covering structure for one source table's UNIQUE constraint.
