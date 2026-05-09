description: Review serialized callback evaluation in returning.ts and window.ts (extends the prior project.ts fix)
files:
  packages/quereus/src/runtime/emit/returning.ts
  packages/quereus/src/runtime/emit/window.ts
  packages/quereus/test/logic/42.1-returning-extras.sqllogic
  packages/quereus/test/logic/07.5-window.sqllogic
----

## What changed

Four `Promise.all` callsites in the runtime emitters that evaluate
SQL-expression callbacks against a shared row-context slot were converted
to sequential `for ... await` loops. This removes a row-context collision
class identical to the one fixed in `emitProject` by ticket
`serialize-project-subquery-evaluation`.

When two callbacks reference the same plan subtree (e.g. a shared CTE
or a cache-deduplicated subquery), their emitted Instruction trees share
plan-node attribute IDs and collapse to the same `RowSlot` for the inner
scan. Under real async I/O (LevelDB store), parallel `Promise.all` over
those callbacks interleaves their `rowSlot.set(row)` calls and overwrites
each other's entries in `RowContextMap.attributeIndex`. Memory mode hides
this because callbacks resolve synchronously in practice.

### Code edits

- `packages/quereus/src/runtime/emit/returning.ts:26-35` — RETURNING
  projection callbacks evaluated sequentially per row.
- `packages/quereus/src/runtime/emit/window.ts:167-184`
  (`groupByPartitions`) — PARTITION BY callbacks evaluated sequentially
  per row.
- `packages/quereus/src/runtime/emit/window.ts:288-318` (`sortRows`) —
  outer `for...of` over rows (was `Promise.all(rows.map(...))`) and inner
  sequential ORDER BY callbacks. Fixes both the per-row sourceSlot race
  and the shared-subtree race in one edit.
- `packages/quereus/src/runtime/emit/window.ts:949-961`
  (`runStreaming`) — streaming partition + ORDER BY callbacks evaluated
  sequentially per row.

### Tests added

- `42.1-returning-extras.sqllogic` §8 — INSERT … RETURNING with two
  scalar subqueries against textually-identical derived tables (the cache
  rule deduplicates them, sharing a plan subtree). `WITH ... INSERT ...
  RETURNING` was the canonical pattern from the ticket but Quereus's
  planner does not propagate the CTE scope into RETURNING projections, so
  the test uses derived tables instead. Result asserts deterministic
  count=3, sum=90 over the post-insert table state.
- `07.5-window.sqllogic` (end of file) — two regression cases:
  - `PARTITION BY (select count(*) from high), (select sum(v) from high)`
    over a CTE `high`. Both keys constant → single partition →
    `row_number()` = 1, 2, 3.
  - `ORDER BY (select count(*) from high), (select sum(v) from high)`
    over the same CTE. Single peer group → outer `ORDER BY v` orders the
    output → `row_number()` = 1, 2, 3.
  These exercise both the buffered (`groupByPartitions`, `sortRows`) and,
  for monotonic-pk windows, the streaming (`runStreaming`) emitter paths.

## Validation

- `yarn build` — green.
- `yarn test` (memory) — all logic tests pass.
- `yarn test:store` (LevelDB) — 561 passing / 1 failing. The single
  failure (`10.5.1-partial-indexes.sqllogic:49`) is pre-existing and
  unrelated; reproduced on stash of these changes.
- `yarn lint` (quereus) — clean.

## Review surface

Suggested review focus, working from the interface boundary inwards:

- Confirm the new tests exercise the bug's premise (shared plan subtree,
  not just two independent subqueries). For the RETURNING test, the
  cache rule must dedupe the two `(select * from tr where v >= 20)`
  derived tables; verify by inspecting the plan
  (`SELECT * FROM query_plan(...)` or equivalent) and confirming a CACHE
  node above the shared scan.
- Confirm that sequential evaluation does not regress performance on
  hot paths. The ticket's note: callbacks are independent per SQL
  semantics, so semantic equivalence holds. Memory-mode workloads were
  already serial in practice (callbacks resolve synchronously); store
  mode pays one extra microtask per callback per row, dominated by the
  scan cost.
- `sortRows` previously parallelised over rows AND callbacks. The new
  code is doubly sequential. The ticket called out this as also fixing
  a per-row `sourceSlot` race that could surface if any ORDER BY
  callback yielded asynchronously; verify this read of the prior code.
- The `evalLagLeadDefault` and other in-loop `await Promise.resolve(cb(...))`
  callsites in window.ts (around lines 401, 441, 448, 462, 499, 528,
  996, 1117, 1211) were *not* changed. Each of those is a single
  callback per call (no Promise.all), so no concurrency exists to
  serialize — but worth a sanity check.
- Docs: `docs/runtime.md` and `docs/architecture.md` describe the
  emitter pipeline; neither references the prior parallel-callback
  pattern, so no doc churn was needed. Verify.

## Test plan for reviewer

- `yarn build && yarn test && yarn test:store` (expect the same
  pre-existing partial-indexes failure, no new regressions).
- `yarn workspace @quereus/quereus run lint`.
- Spot-check the three new test cases with `--show-plan` to confirm the
  shared-subtree premise.

## Out of scope / follow-ups

- WITH-clause visibility in INSERT…RETURNING projections is a planner
  limitation surfaced while writing this ticket's tests. Tracking in
  `backlog/` would make sense if it becomes a customer ask; not blocking
  this fix.
