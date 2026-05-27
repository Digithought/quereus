description: Coerce NEW.* values to column logical types before queueing deferred CHECK rows (GitHub #25)
files: packages/quereus/src/runtime/emit/constraint-check.ts, packages/quereus/src/types/validation.ts, packages/quereus/test/logic/43-transition-constraints.sqllogic
effort: medium
----
GitHub issue: https://github.com/gotchoices/quereus/issues/25

## Problem

A deferred CHECK constraint containing a subquery (e.g.
`check (exists (select 1 from Parent P where P.TS = new.ParentTS))`) compares the
row's **pre-coercion** `new.*` values against rows in other tables that were
**coerced on insert**. For `datetime` (and any other column whose logical type
rewrites the value on `parse`) the equality fails even though the logical values
match.

Validated reproduction (fails on `main`):

```sql
create table Parent (Id text, TS datetime, primary key (Id, TS));
create table Child (
    Id text primary key,
    ParentTS datetime,
    constraint ParentExists check (
        exists (select 1 from Parent P where P.TS = new.ParentTS)
    )
);
insert into Parent values ('p1', 1700000000000);   -- TS coerced to ISO text
insert into Child  values ('c1', 1700000000000);   -- FAILS at COMMIT (should succeed)
```

## Root cause (confirmed against the tree)

Pipeline ordering for INSERT/UPDATE:

```
source → InsertNode (emit/insert.ts: builds flat OLD/NEW row, NO coercion)
       → ConstraintCheckNode (emit/constraint-check.ts: queues deferred row via row.slice())
       → DmlExecutorNode → VTab performInsert/performUpdate (validateAndParse coerces NEW values to column logical types)
```

`emit/insert.ts` explicitly defers type conversion ("Type conversion is handled
by the table manager's validateAndParse in performInsert"). So the row reaching
the ConstraintCheck node still holds raw NEW values. At
`emit/constraint-check.ts:~334`, the deferred branch snapshots
`row.slice()` (raw) into `db._queueDeferredConstraintRow(...)`. At COMMIT,
`deferred-constraint-queue.ts evaluateEntry()` evaluates the subquery with those
raw `new.*` values against the already-coerced stored rows → equality fails.

The flat row layout is `[OLD(0..n-1), NEW(n..2n-1)]`. Storage coerces every NEW
value with `validateAndParse(value, column.logicalType, column.name)` — see
`vtab/memory/layer/manager.ts performInsert/performUpdate` and
`quereus-store/.../store-table.ts coerceRow`.

Immediate (non-deferred) CHECKs are unaffected: both sides of any in-row
comparison see the same raw value, so they still agree. The bug is specific to
deferred CHECKs comparing `new.*` against already-stored (coerced) rows in other
tables (or `committed.*`).

## Fix

Coerce the NEW section of the flat row to the declared column logical types
**before** queueing it for deferred evaluation, mirroring exactly what the
storage layer does to the stored row. This keeps coerced-vs-coerced equality at
deferred-evaluation time.

Apply this at the single shared queue call site in
`emit/constraint-check.ts checkCheckConstraints()` (shared by INSERT and UPDATE
via `emitConstraintCheck`). `tableSchema` is already in scope there. Coerce
indices `numCols .. 2*numCols-1` using
`validateAndParse(value, tableSchema.columns[i].logicalType, tableSchema.columns[i].name)`.

Notes / guards:
- Only coerce the NEW section. OLD values (indices `0..n-1`) are either NULL
  (INSERT) or read from already-coerced stored rows (UPDATE), so they need no
  coercion. `committed.*` is fetched via subquery from stored data — already
  coerced. So coercing NEW alone fixes transition (`committed.*`) constraints too.
- **Preserve error semantics.** This coercion runs during the insert pipeline,
  *before* this row's own `performInsert` runs. For a row with a genuinely
  invalid value, `performInsert` is the authoritative place that throws the
  MISMATCH error. To avoid changing which layer reports the error (and its
  message/timing), wrap the per-cell coercion so a parse failure falls back to
  the **raw** value (e.g. try `validateAndParse`, on throw keep the original).
  For valid rows the coerced value is identical to what gets stored; for invalid
  rows the downstream `performInsert` still throws as today.
- Snapshot into a fresh array (don't mutate the live `row` that continues down
  the pipeline). Currently `row.slice()` is passed; build the coerced copy from
  that slice.
- Consider extracting a tiny local helper `coerceNewSection(row, tableSchema)`
  for clarity; keep it small and single-purpose.

Do **not** attempt to also coerce the mutation `contextRow` — context values are
evaluated expressions not necessarily typed against this table's columns, and the
issue/reproduction does not implicate them. If a follow-up need surfaces, file a
separate ticket.

## Regression test

Add coverage to `test/logic/43-transition-constraints.sqllogic` (alongside the
existing deferred/transition coverage). Use `using memory`. Cover:

- Numeric→datetime coercion across tables (the validated reproduction): Parent
  with `datetime` PK component inserted via numeric literal `1700000000000`;
  Child deferred `exists` CHECK against `Parent.TS` should **succeed** at COMMIT.
- A negative case in the same shape: a Child whose `ParentTS` has no matching
  Parent row still fails the deferred CHECK (`-- error: CHECK constraint failed: ParentExists`),
  proving the fix didn't make the check vacuously pass.
- (Optional) the alternate input representation noted in the issue
  (`'2023-11-14T22:13:20+00:00[UTC]'`) on both sides to lock in coerced-vs-coerced.

sqllogic format reminders (see existing file): `-- run` to execute, `→ [ ... ]`
for expected result rows, `-- error: <message substring>` for expected errors,
explicit `BEGIN; ... COMMIT;` to force the deferred check to fire at commit.

## Validation

- `yarn workspace @quereus/quereus run test 2>&1 | tee /tmp/q-test.log; tail -n 60 /tmp/q-test.log`
  (the default memory-backed run exercises the fix; the store path shares the
  same coercion semantics via `coerceRow`).
- Lint: `yarn workspace @quereus/quereus run lint` (single-quote globs on Windows).
- If any failure looks pre-existing/unrelated to this diff, follow the
  pre-existing-error flow in the stage rules.

## TODO

- [ ] In `emit/constraint-check.ts`, coerce the NEW section of the flat row to
      column logical types before `db._queueDeferredConstraintRow(...)`, with
      parse-failure fallback to the raw value. Import `validateAndParse` from
      `../../types/validation.js`.
- [ ] Build the coerced row into a fresh array (don't mutate the row flowing
      downstream).
- [ ] Add regression cases (positive numeric→datetime success + negative
      no-match failure) to `test/logic/43-transition-constraints.sqllogic`.
- [ ] Run quereus tests + lint; confirm the GitHub #25 reproduction now succeeds.
- [ ] Write a review/ handoff ticket noting any gaps (e.g. contextRow coercion
      deliberately out of scope).
