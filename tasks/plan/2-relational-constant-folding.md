description: Implement relational constant folding to materialize foldable relational subtrees at plan time
dependencies: constant-folding pass, runtime expression evaluator

Scalar constant folding is implemented and working. The next step is relational constant folding: when an entire relational subtree is provably constant (deterministic, readonly, no external dependencies), it can be materialized at plan time into an in-memory relation, eliminating repeated evaluation.

### Use Cases

- `SELECT * FROM (VALUES (1,'a'),(2,'b')) AS t(id,name)` - VALUES clause is constant
- Uncorrelated subqueries that produce constant results
- CTEs whose body is fully constant (no table references or all referenced tables are themselves constant)

### Approach

- The three-phase constant folding algorithm already classifies relational nodes as const/dep/non-const
- Border detection already identifies foldable relational subtrees
- The missing piece is the replacement phase for relational nodes: execute the subtree and replace with a materialized relation node
- The materialized relation node must implement `getAttributes()`, carry correct physical properties, and support iteration

### References

- `src/planner/rules/const/` - constant folding implementation
- `docs/optimizer-const.md` - constant folding design doc
- `docs/optimizer.md` Known Issues section
