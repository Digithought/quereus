description: Incremental maintenance of materialized views whose body is (or contains) a recursive CTE. `materialized-view-incremental-refresh` rejects recursive bodies at create time under `with refresh = 'on-commit-incremental'`; this ticket makes them maintainable.
prereq: materialized-view-incremental-refresh
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/planner/analysis/binding-extractor.ts, docs/materialized-views.md
----

## Problem

A recursive CTE computes a transitive closure (or similar fixpoint). A single changed
source row can ripple through arbitrarily many iterations, so there is no bounded
per-binding residual that recomputes "the affected rows only" without re-deriving the
fixpoint. The binding extractor cannot classify the recursive term's self-reference as
`'row'`/`'group'` against a base table in a way that bounds the apply.

## Expected behavior

`create materialized view ... with refresh = 'on-commit-incremental'` over a recursive
body either maintains correctly on COMMIT (e.g. via semi-naïve delta evaluation seeded
from the changed source tuples) or continues to error clearly. Acceptance bar:
correctness under source insert/update/delete verified against a full-rebuild oracle,
including edge cases that shrink the closure (deletes that disconnect a subgraph).

## Notes

Semi-naïve / DRed-style delta evaluation is the known technique; integrating it with
the existing `DeltaExecutor` per-binding model is the open design question. Research-grade.
