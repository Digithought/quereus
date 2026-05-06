description: Cross-check SQLite WHERE-clause and BETWEEN tests against Quereus and write fixtures for gaps
prereq:
files: docs/sqlite-test-crosscheck.md, docs/sqlite-test-crosscheck-process.md, packages/quereus/test/logic/
----

## Scope

For each `unreviewed` **WHERE-related** row in the **"WHERE, JOIN, indexing"** section of `docs/sqlite-test-crosscheck.md`: examine the SQLite source against existing Quereus coverage, write tests for any uncovered scenarios, then mark the row `reviewed (<handle>, date)` or `n/a (<reason>)`. The JOIN and index rows are owned by separate tickets (`5-sqlite-xref-joins.md`, `5-sqlite-xref-indexes.md`) — leave those alone here.

In-scope rows (WHERE-related):
- `where.test`, `where1.test` – `where9.test`, `whereA.test` – `whereJ.test`
- `between.test`
- `null.test` (predicate semantics on NULL)

## Shared rules

Read `docs/sqlite-test-crosscheck-process.md` first.

## Critical constraints (override default tess behavior)

- **Do not run tests, build, or lint.**
- **Do not modify engine code.**
- **Do not file follow-up tickets** for the gaps.
- **Do not mirror SQLite tests in bulk.** Distill.
- **`n/a` rows get no fixture and no ticket.**
- **Do not touch JOIN or index rows** in the same section — separate tickets own those.

## Category-specific notes

- The bulk of `where*.test` is index-selection regressions. Many scenarios are about *which index gets picked*, not output correctness. Quereus's planner is different — focus on output-correctness scenarios; plan-shape decisions belong in `test/optimizer/*.spec.ts` or `test/plan/`, not `.sqllogic`.
- SQLite tests `WHERE 0`/`WHERE 1` short-circuit a lot. Verify Quereus folds these (planner-side coverage in `test/optimizer/relational-const-folding.spec.ts` and `85-relational-const-folding.sqllogic` exists).
- BETWEEN with NULL bound, reversed bounds, type-mixed bounds — likely gap territory.
- LIKE/GLOB are NOT in this ticket — they're in `5-sqlite-xref-functions-scalar.md`.
- IS NULL / IS NOT NULL / IS / IS NOT semantics — fixtures may belong here even if the SQLite source is in a different file.
- `null.test` overlap with `21-null-edge-cases.sqllogic` — calibrate carefully.

## TODO

- [ ] Read process doc and assigned subset of index doc
- [ ] Dispatch one Explore subagent per SQLite source file, parallel batches of 4–8
- [ ] Collate reports; write `.sqllogic` fixtures (feature-named, with numeric prefix) for any uncovered scenarios
- [ ] Update each row's Status to `reviewed (<handle>, date)` or `n/a (<reason>)`
- [ ] Do not run tests; do not build

## Output

Move to `tickets/review/`. Summary: counts, new fixture paths, confirmation no commands ran.
