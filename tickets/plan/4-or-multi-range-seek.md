description: OR disjunctions with range predicates on same index → multiple range scans
dependencies: constraint-extractor, rule-select-access-path, ScanPlan, cursor layer
files: packages/quereus/src/planner/analysis/constraint-extractor.ts, packages/quereus/src/planner/rules/access/rule-select-access-path.ts
----

## Summary

OR disjunctions with range predicates on the same index columns (e.g., `WHERE date > '2024-01' OR date < '2023-06'`) should be served by multiple range scans on the same index rather than falling back to a sequential scan with residual filter.  With this, we may be able to unlock other optimizations, which we should add tickets for.

## Use case

Queries with non-contiguous range conditions on indexed columns:
- `WHERE price > 1000 OR price < 10` — two disjoint ranges on a price index
- `WHERE date > '2024-01' OR date < '2023-06'` — two disjoint date ranges
- `WHERE score BETWEEN 90 AND 100 OR score BETWEEN 0 AND 10` — two bounded ranges

Currently these fall through as residual filters because the constraint extractor only collapses OR-of-equality to IN. Range predicates in OR branches are not extracted.

## Requirements

- Extend the OR branch analysis in `constraint-extractor.ts` to detect range predicates on the same column/index
- Extend `ScanPlan` to support multiple range specs per scan (currently single lower/upper bound pair)
- Extend the cursor layer to execute multiple range scans and merge/concatenate results
- Access path selection must construct multi-range seek plans from extracted OR-range constraints
- Correct duplicate elimination or disjoint range guarantee when ranges overlap

## Foundation

The OR branch analysis infrastructure (`flattenOrDisjuncts`, `tryExtractOrBranches`) from the OR predicate support work provides the starting point.
