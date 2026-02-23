description: Detect and eliminate common subexpressions in query plans
dependencies: optimizer framework, physical properties

Common subexpression elimination (CSE) identifies duplicate computation in a query plan and ensures each unique subexpression is computed only once. This reduces both CPU work and memory pressure.

### Scope

- Scalar CSE: detect repeated scalar expressions (e.g., `length(name)` used in both SELECT and WHERE) and compute once via a shared reference
- Relational CSE: detect shared relational subtrees (beyond CTEs) and materialize once
- Integration with the existing CTE optimization (which already handles explicit WITH clauses)
- Expression hashing/fingerprinting for efficient duplicate detection

### References

- `src/planner/rules/cache/` - existing CTE and caching infrastructure
- `docs/optimizer.md` Future Directions section
