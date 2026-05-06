description: Cross-check SQLite aggregate and window-function tests against Quereus and write fixtures for gaps
prereq:
files: docs/sqlite-test-crosscheck.md, docs/sqlite-test-crosscheck-process.md, packages/quereus/test/logic/
----

## Scope

For each `unreviewed` row in the **"Aggregates and window functions"** section of `docs/sqlite-test-crosscheck.md`: examine the SQLite source against existing Quereus coverage, write `.sqllogic` (or property/unit) tests for any uncovered scenarios, then mark the row `reviewed (<handle>, date)` or `n/a (<short reason>)`.

In-scope:
- `aggfunc.test`, `aggnested.test`
- `count.test`, `having.test`, `groupby.test`
- `minmax.test`, `minmax2.test`, `minmax3.test`, `minmax4.test`
- `window1.test` – `window9.test`
- `windowfault.test` (mostly OOM in SQLite — only the grammar/error-path subset applies; rest is `n/a`)

If `count.test`/`having.test`/`groupby.test`/`minmax*.test` are also referenced in the "SELECT, projection, ORDER BY, LIMIT" section, this ticket owns them — leave a `(see aggregates-windows ticket)` note in the SELECT section's row if duplicated.

## Shared rules

Read `docs/sqlite-test-crosscheck-process.md` first.

## Critical constraints (override default tess behavior)

- **Do not run tests, build, or lint.**
- **Do not modify engine code.**
- **Do not file follow-up tickets** for gaps.
- **Do not mirror SQLite tests in bulk.**
- **`n/a` rows get no fixture.**

## Category-specific notes

- Existing coverage: `07-aggregates.sqllogic`, `06.6-aggregate-extended.sqllogic`, `25-aggregate-edge-cases.sqllogic`, `07.5-window.sqllogic`, `27-window-edge-cases.sqllogic`, `92-hash-aggregate-edge-cases.sqllogic`. Significant overlap is likely — only write a new test if the SQLite scenario isn't already exercised.
- DISTINCT inside aggregate args (`COUNT(DISTINCT x)`, `GROUP_CONCAT(DISTINCT x)`) — verify and pin down.
- FILTER clause (`COUNT(*) FILTER (WHERE …)`) — verify support.
- ORDER BY inside aggregate (`GROUP_CONCAT(x ORDER BY y)`) — likely gap.
- Window frame specifications: `ROWS`, `RANGE`, `GROUPS`, with all combinations of `BETWEEN … AND …`, `EXCLUDE` clauses. RANGE-with-numeric-offset and RANGE-with-temporal-offset are subtle.
- Named window definitions (`WINDOW w AS (…)`).
- `windowfault.test`: most is OOM/memory injection — `n/a`. Only fixture grammar errors and edge-case window definitions if they apply.
- MIN/MAX as both scalar and aggregate: `MIN(x, y, z)` (scalar) vs `SELECT MIN(x) FROM t` (aggregate).

## TODO

- [ ] Read process doc and assigned section of index doc
- [ ] Dispatch subagents (one per SQLite source file, parallel batches of 4–8)
- [ ] Collate reports; write tests for any uncovered scenarios
- [ ] Update each row's Status to `reviewed (<handle>, date)` or `n/a (<reason>)`
- [ ] Do not run tests; do not build

## Output

Move to `tickets/review/`. Summary as standard.
