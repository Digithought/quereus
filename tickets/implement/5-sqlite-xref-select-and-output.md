description: Cross-check SQLite SELECT/ORDER BY/LIMIT/DISTINCT tests against Quereus and write fixtures for gaps
prereq:
files: docs/sqlite-test-crosscheck.md, docs/sqlite-test-crosscheck-process.md, packages/quereus/test/logic/
----

## Scope

For each `unreviewed` row in the **"SELECT, projection, ORDER BY, LIMIT"** section of `docs/sqlite-test-crosscheck.md`: examine the SQLite source against existing Quereus coverage, write tests for any uncovered scenarios, then mark the row `reviewed (<handle>, date)` or `n/a (<reason>)`.

## SQLite test files in this category

- `select1.test` – `select9.test`, `selectA-E.test`, `e_select.test`
- `orderby1.test` – `orderby9.test`
- `limit.test`, `limit2.test`
- `distinct.test`, `distinct2.test`
- `count.test`, `having.test`, `groupby.test`, `minmax.test`–`minmax4.test` — these may end up reassigned to the aggregates ticket if they fit better there. Coordinate inline if needed (mark them in this section's row as `(see aggregates-windows ticket)` and stop).

## Shared rules

Read `docs/sqlite-test-crosscheck-process.md` first. It defines the workflow, status calibration, test-output preferences (`.sqllogic` > property > unit), naming (feature- or scenario-named, matching existing convention), and subagent prompt template.

## Critical constraints (override default tess behavior)

- **Do not run tests, build, or lint.** No `yarn test`, no `yarn build`. This ticket creates tests; making them pass is a separate pass.
- **Do not modify engine code.** Only `docs/sqlite-test-crosscheck.md` and new files under `packages/quereus/test/logic/` are touched.
- **Do not file follow-up tickets** for the gaps. The new test files are the deliverable.
- **Do not mirror SQLite tests in bulk.** Distill scenarios.
- **`n/a` rows get no fixture and no ticket.**

## Category-specific notes

- `e_select.test` is the high-value "encyclopedia" file — it exercises grammar systematically. Expect more `gap` decisions here than the regression-style files.
- ORDER BY with NULL ordering (`NULLS FIRST/LAST`) is common in SQLite tests. Verify Quereus's NULL-ordering default and write fixtures that pin it down.
- `select4.test`/`select8.test` are heavy on compound SELECT (UNION/INTERSECT/EXCEPT) — much of that overlaps with `09-set_operations.sqllogic` and `28-set-ops-sort-edge-cases.sqllogic`. Be precise in calibration; don't double-write.
- LIMIT + OFFSET edge cases (negative, NULL, expression-valued) — `94.1-limit-offset-edge-cases.sqllogic` already covers many; check before flagging gaps.
- Quereus has no rowid, so any SQLite test relying on implicit rowid ordering or `ROWID` references is `n/a`.

## TODO

- [ ] Read `docs/sqlite-test-crosscheck-process.md`
- [ ] Read the assigned section of `docs/sqlite-test-crosscheck.md`
- [ ] Dispatch one Explore subagent per SQLite source file, in parallel batches of 4–8, using the prompt template from the process doc
- [ ] Collate subagent reports; write `.sqllogic` fixtures (feature-named, with numeric prefix) for any uncovered scenarios
- [ ] Update each row's Status to `reviewed (<handle>, date)` or `n/a (<reason>)`
- [ ] Do **not** run tests; do **not** build; do **not** debug

## Output

Move this ticket to `tickets/review/` when done. The review summary should list:
- Counts: reviewed / n/a / unreviewed
- New fixture file paths under `packages/quereus/test/logic/`
- Open questions for the human (if any)
- Explicit confirmation that no test/build commands were run
