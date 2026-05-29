description: Multi-row UPDATE/DELETE statements lack the per-statement savepoint that INSERT has, so a mid-statement failure inside an explicit transaction can leave earlier rows of the same statement applied (non-atomic statement). Pre-existing; surfaced while reviewing row-time MV maintenance, which adds a new mid-statement throw site to these paths.
prereq:
files: packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/src/core/statement.ts, packages/quereus/src/core/database-transaction.ts
----

## Observed

`runInsert` (dml-executor.ts) wraps each INSERT statement in a statement-level
savepoint (`__or_abort_*`) so an abort mid-statement rolls the whole statement back
(see test `53-materialized-views-rowtime.sqllogic` §10, which verifies a failed
multi-row insert leaves no partial state — source or MV backing). `runUpdate` and
`runDelete` do **not** create such a savepoint.

Consequence: inside an **explicit** transaction (`begin; ...`), a multi-row UPDATE
or DELETE whose Nth row throws (constraint violation, FK action error, or — newly —
the row-time MV maintenance hook) propagates the error but does **not** roll back
rows 1..N-1 of that statement. The statement is left partially applied. In
autocommit mode this is masked because `_finalizeImplicitTransaction` rolls back the
whole implicit transaction on error, so the statement is atomic there.

This predates the row-time work. It is filed here because the row-time maintenance
hook adds a new throw site *inside* the unprotected UPDATE/DELETE loop, widening the
surface. Note: source and backing-table writes stay in lockstep (same connection,
same commit/rollback fate), so a row-time MV never *diverges* from its source — the
defect is purely the statement-level atomicity of the UPDATE/DELETE itself.

## Expected

A single SQL statement should be atomic: either all its row effects apply or none,
even within an explicit transaction (SQLite implicit-savepoint-per-statement
semantics).

## Direction (for the planner, not prescriptive)

Extend the `runInsert` statement-savepoint pattern (create `__stmt_*` savepoint at
statement start, release on success, rollback-to on any throw) to `runUpdate` and
`runDelete`. Confirm the savepoint broadcast reaches lazily-registered connections
(including a row-time backing connection registered mid-statement). Add sqllogic
coverage: `begin; insert two rows; update or delete a multi-row set where row 2
violates a constraint; rollback expectation` — assert the first row's effect did not
survive.

## Validation gap to be aware of

`UPDATE OR REPLACE` does not currently parse in Quereus, so the row-time
REPLACE-on-update throw path may be hard to trigger from SQL; use a constraint
violation (e.g. NOT NULL / CHECK / FK) on a later row of a plain multi-row UPDATE to
exercise the atomicity gap instead.
