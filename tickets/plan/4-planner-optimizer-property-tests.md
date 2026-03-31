description: Property-based tests for planner and optimizer correctness
dependencies: fast-check (already in use)
files: test/property.spec.ts, packages/quereus/src/planner/framework/, packages/quereus/src/planner/rules/
----

Expand the existing property-based test suite (currently focused on parser, values, collation) to cover the planner and optimizer — the richest bug surface in Quereus.

### Key properties to test

**Optimizer rule equivalence**: For each optimizer rule, generate random queries, run them with the rule enabled vs disabled, and assert identical result sets (order-insensitive). This verifies that no rule silently changes semantics. Requires a mechanism to selectively disable individual rules during a test run.

**Optimizer idempotency**: Optimizing an already-optimized plan should produce the same plan. Run the optimizer twice and compare plan structures.

**Join commutativity**: `A JOIN B ON ...` and `B JOIN A ON ...` should produce the same result set (order-insensitive). Generate random two-table schemas with data, join them both ways, compare.

**Predicate pushdown correctness**: A query with a WHERE clause applied before vs after a join should produce the same results. Generate joins with filterable predicates, compare pushed-down vs non-pushed-down execution.

**NULL propagation invariants**: Verify known NULL algebra rules hold across random expressions — e.g., `X AND NULL` when X is false should be false, `NULL = NULL` is NULL, aggregate functions skip NULLs (except COUNT(*)), etc.

**Monotonicity**: Adding a WHERE clause to a query should never increase the result count. Adding an additional JOIN condition should never increase the result count for INNER joins.

**Projection invariance**: Selecting a subset of columns should not change the number of rows returned (unless DISTINCT is involved).

### Approach

Use fast-check's `letrec` or custom arbitraries to generate:
- Random table schemas (1-5 columns, varied types)
- Random data sets (0-20 rows per table)
- Random queries over those schemas (start simple: SELECT/WHERE/JOIN/GROUP BY)

Each generated scenario creates a fresh Database, inserts the data, runs the query variants, and compares results.

Start with simple queries and expand complexity over time. The generator itself will be a reusable asset for other testing strategies (grammar fuzzing, differential testing).
