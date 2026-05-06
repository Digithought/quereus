description: Cross-check SQLite subquery, CTE, IN/EXISTS, and set-op tests against Quereus and write fixtures for gaps
prereq:
files: docs/sqlite-test-crosscheck.md, docs/sqlite-test-crosscheck-process.md, packages/quereus/test/logic/
----

## Scope

For each `unreviewed` row in the **"Subqueries, CTEs, set ops"** section of `docs/sqlite-test-crosscheck.md`: examine the SQLite source against existing Quereus coverage, write tests for any uncovered scenarios, then mark the row `reviewed (<handle>, date)` or `n/a (<reason>)`.

In-scope:
- `subquery.test`, `subquery2.test`
- `with1.test` – `with5.test`
- `exists.test`
- `in.test`, `in2.test` – `in5.test`
- `compound.test` (and the compound-SELECT subsets of `select4.test`, `select8.test` not already taken by `5-sqlite-xref-select-and-output.md` — coordinate inline if overlap is confusing).

## Shared rules

Read `docs/sqlite-test-crosscheck-process.md` first.

## Critical constraints (override default tess behavior)

- **Do not run tests, build, or lint.**
- **Do not modify engine code.**
- **Do not file follow-up tickets** for gaps.
- **Do not mirror SQLite tests in bulk.**
- **`n/a` rows get no fixture.**

## Category-specific notes

- Correlated subqueries: existing coverage at `07.6-subqueries.sqllogic`, `07.7-in-subquery-caching.sqllogic`, `07.8-correlated-subquery-edges.sqllogic`, `96-subquery-edge-cases.sqllogic`. Calibrate carefully; many scenarios likely covered.
- Recursive CTEs: `13.1-cte-multiple-recursive.sqllogic`, `13.2-cte-bind-params.sqllogic`, `13.3-cte-edge-cases.sqllogic`. SQLite has rich `with*.test` regressions — check for cycle detection, mutual recursion, ORDER BY in recursive part, etc.
- IN-list with mixed types and NULLs: `21-null-edge-cases.sqllogic` partially covers. The three-valued logic of `x IN (a, b, NULL)` is famously subtle — likely gap territory.
- EXISTS / NOT EXISTS empty/non-empty: `08.1-semi-anti-join.sqllogic` covers semi/anti-join optimization but may not cover semantics. Check.
- UNION/INTERSECT/EXCEPT row-equality with NULLs (treats NULLs as equal for set semantics, unlike `=`) — likely gap.
- `compound.test`: ORDER BY/LIMIT in the outer compound vs inner branches.

## TODO

- [ ] Read process doc and assigned section of index doc
- [ ] Dispatch subagents (one per SQLite source file, parallel batches of 4–8)
- [ ] Collate reports; write tests for any uncovered scenarios
- [ ] Update each row's Status to `reviewed (<handle>, date)` or `n/a (<reason>)`
- [ ] Do not run tests; do not build

## Output

Move to `tickets/review/`. Summary as standard.
