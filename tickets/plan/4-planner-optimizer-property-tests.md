description: Property-based tests targeting planner and optimizer correctness invariants
dependencies: fast-check (already in devDependencies)
files: test/property.spec.ts, src/planner/framework/registry.ts, src/planner/rules/
----

Existing property tests (test/property.spec.ts) cover parser robustness, value round-trips, collation, and comparison invariants.  The planner and optimizer — the most complex subsystems — have no property-based coverage.

This ticket adds property-based tests that exercise planner/optimizer invariants across randomly generated queries and data:

**Semantic equivalence under optimizer rules**
For each optimizer rule (or combination), run a query with the rule enabled and disabled, and assert identical result sets (order-insensitive).  This requires a mechanism to selectively disable individual rules — either a test-only flag on the optimizer registry or a Database option.  If one doesn't exist, add a minimal one.

**Optimizer idempotency**
Optimizing an already-optimized plan a second time should produce the same plan structure.

**Join commutativity**
`A JOIN B ON ...` and `B JOIN A ON ...` should produce the same result set (modulo column order).

**Monotonicity of WHERE**
Adding a WHERE clause to a query should never increase the number of result rows compared to the same query without it.

**NULL algebra**
Verify known NULL invariants: `NULL = NULL` is not true, `NULL IN (...)` behavior, `COALESCE` semantics, `IS NULL`/`IS NOT NULL` consistency, aggregate skipping of NULLs (except `count(*)`).

**Aggregate invariants**
`count(*)` >= `count(col)`.  `min(col)` <= `max(col)` when both non-NULL.  `sum` of a single row equals the value.  `avg` is between `min` and `max`.

**Approach**
Use fast-check to generate random schemas (1-3 tables, 2-5 columns of mixed types), populate with random data (0-50 rows), and generate queries that exercise the properties above.  Start simple (single-table, then two-table joins) and expand.
