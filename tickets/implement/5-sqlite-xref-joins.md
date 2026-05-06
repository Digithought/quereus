description: Cross-check SQLite JOIN tests against Quereus and write fixtures for gaps
prereq:
files: docs/sqlite-test-crosscheck.md, docs/sqlite-test-crosscheck-process.md, packages/quereus/test/logic/
----

## Scope

For each `unreviewed` **JOIN-related** row in the "WHERE, JOIN, indexing" section of `docs/sqlite-test-crosscheck.md`: examine the SQLite source against existing Quereus coverage, write tests for any uncovered scenarios, then mark the row `reviewed (<handle>, date)` or `n/a (<reason>)`.

In-scope rows:
- `join.test`, `join1.test` – `join7.test`
- `joinB.test`, `joinC.test`, `joinD.test`, `joinE.test`, `joinF.test`, `joinG.test`, `joinH.test`

## Shared rules

Read `docs/sqlite-test-crosscheck-process.md` first.

## Critical constraints (override default tess behavior)

- **Do not run tests, build, or lint.**
- **Do not modify engine code.**
- **Do not file follow-up tickets** for gaps.
- **Do not mirror SQLite tests in bulk.**
- **`n/a` rows get no fixture.**

## Category-specific notes

- INNER, LEFT, CROSS, NATURAL, USING, ON — fixtures should pin down each join type's NULL-padding and column-resolution behavior. Existing coverage: `11-joins.sqllogic`, `12-join_padding_order.sqllogic`, `23-self-joins-duplicates.sqllogic`, `26-join-edge-cases.sqllogic`.
- RIGHT JOIN and FULL OUTER JOIN — verify Quereus supports them. SQLite added support in 3.39; if Quereus accepts the syntax, add output-correctness fixtures. If it rejects with a clear error, write fixtures with `-- error:` to pin that down.
- `USING (col)` with collation/type mismatch — likely gap.
- 3+ table joins with mixed inner/outer — `26-join-edge-cases.sqllogic` may cover; calibrate.
- Plan-shape concerns (which join algorithm) belong in `test/optimizer/`, not `.sqllogic`. The semi/anti-join coverage at `08.1-semi-anti-join.sqllogic` and `82-bloom-join.sqllogic`/`83-merge-join.sqllogic` is plan-shape; don't duplicate.
- Quereus has no implicit rowid in JOIN ON, so any SQLite scenario using `t1.rowid` is `n/a`.

## TODO

- [ ] Read process doc and assigned subset of index doc
- [ ] Dispatch subagents (one per SQLite source file, parallel batches of 4–8)
- [ ] Collate reports; write tests for any uncovered scenarios
- [ ] Update each row's Status to `reviewed (<handle>, date)` or `n/a (<reason>)`
- [ ] Do not run tests; do not build

## Output

Move to `tickets/review/`. Summary as standard.
