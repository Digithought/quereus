description: A single-row literal `VALUES (...)` does not advertise the `∅ → all_cols` singleton (≤1-row) FD, so ≤1-row optimizations (whole-Sort elimination, DISTINCT elimination, GROUP BY simplification, FD-driven join key propagation) do not fire over a single-row VALUES source even though it is provably ≤1-row.
files: packages/quereus/src/planner/nodes/values-node.ts, packages/quereus/src/planner/util/fd-utils.ts (keysOf/isUnique/hasSingletonFd)
----

## Opportunity

Discovered during the `sort-elimination-over-singleton` review. `ValuesNode` declares
`keys: []` ("VALUES doesn't have inherent keys", `values-node.ts:66`) and has no
`computePhysical` override, so it advertises no functional dependencies. When the VALUES
clause has **exactly one row** it is provably ≤1-row and should carry the `∅ → all_cols`
singleton FD (equivalently, the empty key `[]` in `keysOf`), just as scalar aggregates and
`LIMIT 1` subqueries already do.

Concretely, `SELECT * FROM (VALUES (1, 2)) AS v(a, b) ORDER BY a` retains a useless Sort,
whereas the equivalent over a scalar aggregate or `LIMIT 1` source has the Sort eliminated
by `rule-orderby-fd-pruning`. The same gap suppresses DISTINCT elimination, GROUP BY
simplification, and singleton-FD join propagation over a single-row VALUES.

## Expected behavior

A `ValuesNode` with `rows.length <= 1` should expose physical properties such that
`isUnique([], valuesNode)` is true — most naturally by emitting the `∅ → all_cols`
singleton FD via a `computePhysical` override (mirroring how scalar aggregates declare it).
Multi-row VALUES must be unaffected (no key, remains a bag).

## Notes / scope

- Pure optimization / completeness improvement; no correctness change (the surviving Sort
  over one row is merely redundant work).
- VALUES is a zero-ary relational node (`getRelations(): []`), so the FD must be produced
  directly in its own `computePhysical`, not propagated from a child.
- Empty VALUES (`rows.length === 0`) is also ≤1-row and would equally satisfy the empty key,
  though that path is rarely planned — decide whether to gate on `<= 1` or `=== 1`.
- Verify downstream: once the empty key flows from a single-row VALUES, confirm DISTINCT
  elimination / ORDER BY whole-Sort elimination / join singleton-FD propagation pick it up
  (they already read through `keysOf`/`isUnique`, so no consumer changes expected).
