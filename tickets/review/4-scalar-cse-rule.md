description: Scalar common subexpression elimination optimizer rule
files:
  - packages/quereus/src/planner/rules/cache/rule-scalar-cse.ts (new)
  - packages/quereus/src/planner/optimizer.ts (rule registration)
  - packages/quereus/src/planner/analysis/expression-fingerprint.ts (dependency)
  - packages/quereus/test/optimizer/scalar-cse.spec.ts (new - 11 tests)
  - packages/quereus/test/logic/86-scalar-cse.sqllogic (new - 8 queries)
  - docs/optimizer.md (updated)
----

## What was built

An optimizer rule (`ruleScalarCSE`) that detects duplicate scalar expression computations across a ProjectNode and its immediate relational child chain (Filter, Sort) and ensures each unique expression is computed only once.

### How it works

1. Collects all non-trivial scalar subexpressions from the ProjectNode's projections, the FilterNode's predicate, and the SortNode's sort keys
2. Fingerprints each subexpression using `fingerprintExpression()`
3. Groups by fingerprint; keeps only groups with 2+ distinct node instances
4. Injects a new ProjectNode below the lowest usage point that computes each deduplicated expression once (passthrough + computed columns)
5. Replaces all duplicate occurrences with ColumnReferenceNodes pointing to the new attributes

### Example transformation

```
ProjectNode [length(name), upper(name)]        ProjectNode [$cse_ref, upper(name)]
  FilterNode [length(name) > 5]          →       FilterNode [$cse_ref > 5]
    SeqScan t                                       ProjectNode [*, length(name) as $cse]
                                                      SeqScan t
```

### Guards

- Only deduplicates **deterministic** expressions (`physical.deterministic !== false`)
- Skips bare column references, literals, and parameter references (cheap to recompute)
- Requires 2+ distinct node instances sharing the same fingerprint
- Returns `null` (no-op) when no duplicates exist
- Preserves attribute IDs on the outer ProjectNode

### Registration

- Pass: Structural (top-down), priority 22 (after filter-merge at 21, before subquery-decorrelation at 25)
- Node type: `PlanNodeType.Project`
- Rule ID: `scalar-cse`

## Testing

### Optimizer spec tests (11 tests in `test/optimizer/scalar-cse.spec.ts`)
- Function in projection + filter (length(name) shared)
- Arithmetic in projection + filter + ORDER BY (price*qty shared)
- Non-deterministic NOT deduplicated (random())
- Bare column references NOT deduplicated
- Multiple filter conditions sharing same expression
- Intra-projection duplicates
- Expression in projection + ORDER BY
- No CSE when no duplicates exist
- Nested function calls with shared subexpression
- Plan introspection: CSE ProjectNode injected when duplicates exist
- Plan introspection: no CSE node for bare column references

### SQLLogic tests (8 queries in `test/logic/86-scalar-cse.sqllogic`)
- Correctness verification across all CSE scenarios

### Pre-existing failures
- `08.1-semi-anti-join.sqllogic` (1 test) - pre-existing, unrelated to CSE
- `keys-propagation.spec.ts` join test - pre-existing, unrelated

## Usage

No user-facing API changes. The rule fires automatically during query optimization for queries where the same expression appears in multiple positions (SELECT + WHERE, SELECT + ORDER BY, WHERE + ORDER BY, or within WHERE itself).
