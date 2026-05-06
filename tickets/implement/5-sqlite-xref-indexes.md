description: Cross-check SQLite index tests against Quereus and write fixtures for gaps
prereq:
files: docs/sqlite-test-crosscheck.md, docs/sqlite-test-crosscheck-process.md, packages/quereus/test/logic/
----

## Scope

For each `unreviewed` **index-related** row in the "WHERE, JOIN, indexing" section of `docs/sqlite-test-crosscheck.md`: examine the SQLite source against existing Quereus coverage, write tests for any uncovered scenarios, then mark the row `reviewed (<handle>, date)` or `n/a (<reason>)`.

In-scope rows:
- `index.test`, `index1.test` – `index7.test`
- `indexedby.test`
- `descidx*.test` (descending indexes)

## Shared rules

Read `docs/sqlite-test-crosscheck-process.md` first.

## Critical constraints (override default tess behavior)

- **Do not run tests, build, or lint.**
- **Do not modify engine code.**
- **Do not file follow-up tickets** for gaps.
- **Do not mirror SQLite tests in bulk.**
- **`n/a` rows get no fixture.**
- **Do not touch WHERE or JOIN rows** — separate tickets.

## Category-specific notes

- Quereus addresses tables by primary key only — there's no separate `CREATE INDEX … ON rowid` notion. SQLite scenarios about implicit rowid indexes are `n/a`.
- Partial indexes (`WHERE …` clause on `CREATE INDEX`) and expression indexes — verify Quereus support; likely partial or gap. Fixtures should pin down what's accepted.
- `INDEXED BY` and `NOT INDEXED` syntax — `10.5-indexes.sqllogic` may already cover; calibrate carefully.
- DESC indexes overlap with `40.1-pk-desc-direction.sqllogic`.
- Many SQLite index tests assert specific plan shapes via EXPLAIN QUERY PLAN. These belong in `test/optimizer/` or `test/plan/`, not `.sqllogic` — if the scenario is purely about plan shape, classify the row as `partial` and put the fixture under `test/optimizer/` as a unit test rather than `.sqllogic`. Name the test after what it asserts, no special prefix.

## TODO

- [ ] Read process doc and assigned subset of index doc
- [ ] Dispatch subagents (one per SQLite source file, parallel batches of 4–8)
- [ ] Collate reports; write tests for any uncovered scenarios (output-correctness → `.sqllogic`; plan-shape → `test/optimizer/*.spec.ts`)
- [ ] Update each row's Status to `reviewed (<handle>, date)` or `n/a (<reason>)`
- [ ] Do not run tests; do not build

## Output

Move to `tickets/review/`. Summary as standard.
