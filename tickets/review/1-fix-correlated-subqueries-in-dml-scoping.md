description: Outer DML target table now visible to correlated subqueries in UPDATE SET / WHERE / RETURNING and DELETE WHERE / RETURNING. Also fixes UPDATE assignment evaluators not awaiting async (scalar subquery) values.
prereq:
files:
  packages/quereus/src/planner/building/update.ts
  packages/quereus/src/planner/building/delete.ts
  packages/quereus/src/runtime/emit/update.ts
  packages/quereus/src/planner/scopes/aliased.ts
  packages/quereus/src/planner/scopes/registered.ts
  packages/quereus/test/logic/07.6.1-subquery-extras.sqllogic
  packages/quereus/test/logic/01.6-update-extras.sqllogic
  packages/quereus/test/logic/01.8-delete-extras.sqllogic
----
## What changed

Two related defects were fixed so correlated subqueries in DML statements behave per SQL semantics.

### 1. DML target table not visible to correlated subqueries (planner/scopes)

`buildUpdateStmt` and `buildDeleteStmt` constructed a `RegisteredScope` that registered only **unqualified** column symbols (`id`, `name`, ...). They omitted the `AliasedScope` wrapper that the SELECT path uses (`buildFrom` → `registerColumnScope`), so the qualified form `tableName.column` had no resolver. When a nested subquery referenced the outer DML target via its table name (`sqx_outer.id`, `del_parent.id`, `seq.x`, ...), resolution walked up to the parent context, found nothing, and the planner threw `<table>.<col> isn't a column`.

Fix: wrap the column-registered scope in `AliasedScope(registered, tableName, tableName)` (mirroring SELECT's `registerColumnScope`). Now `tablename.column` correctly delegates to the unqualified resolver in the wrapped `RegisteredScope`. Self-correlated EXISTS over the same DML target with a different alias inside the subquery (`delete from seq where exists (select 1 from seq as s2 where s2.x = seq.x + 1)`) also works: the inner SELECT's own `AliasedScope('seq','s2')` handles `s2.x`, and the outer DML scope handles `seq.x`.

### 2. UPDATE assignment evaluators not awaited (runtime/emit)

Once fix #1 enabled correlated scalar subqueries in UPDATE SET, those subqueries (always async because they iterate `AsyncIterable<Row>`) returned `Promise<SqlValue>` from their callback. `emitUpdate` was casting `assignmentEvaluators[i](rctx) as SqlValue` without awaiting, so the Promise object reached `MemoryTableManager.performUpdate` → `validateAndParse`, which rejected it with `Cannot convert object to TEXT/INTEGER`.

Fix: `await` the regular-assignment evaluator (mirroring `filter.ts`, which already does `await predicate(rctx)`). Generated columns are validated as deterministic by `validateDeterministicGenerated` and cannot contain scalar subqueries, so Phase 2 stays synchronous (also avoiding a `withRowContext` lifetime issue — its `finally` removes the row context synchronously).

## Use cases / behavioural expectations

All five repro cases from the original ticket now succeed:

- `update sqx_outer set val = (select coalesce(sum(amount), 0) from sqx_inner where sqx_inner.ref_id = sqx_outer.id);` — correlated aggregate scalar subquery in UPDATE SET
- `update tgt_lookup set name = (select val from src_lookup where src_lookup.id = tgt_lookup.id);` — correlated plain SELECT in UPDATE SET
- `delete from del_parent where exists (select 1 from del_child where del_child.parent_id = del_parent.id);` — correlated EXISTS in DELETE WHERE
- `delete from orders where not exists (select 1 from customers where customers.id = orders.customer_id and customers.active = 1);` — correlated NOT EXISTS in DELETE WHERE
- `delete from seq where exists (select 1 from seq as s2 where s2.x = seq.x + 1);` — self-correlated EXISTS over the same DML target with a different alias inside

UPDATE/DELETE do not currently support a target-table alias in their grammar (no `alias` field on `AST.UpdateStmt` / `AST.DeleteStmt`), so qualified resolution is keyed on the table name only. If/when alias support lands, `tableScope` should be constructed with the alias instead of (or in addition to) the table name, exactly as SELECT does.

## Tests

The five `-- TODO bug:` blocks in the ticket's reference files are now uncommented and assert the expected results:

- `packages/quereus/test/logic/07.6.1-subquery-extras.sqllogic:15`
- `packages/quereus/test/logic/01.6-update-extras.sqllogic:28`
- `packages/quereus/test/logic/01.8-delete-extras.sqllogic:15`
- `packages/quereus/test/logic/01.8-delete-extras.sqllogic:32`
- `packages/quereus/test/logic/01.8-delete-extras.sqllogic:89`

## Validation

- `yarn build` clean
- `yarn lint` clean
- `yarn test`: 596 pass, 1 fail. The single failure is `18-json-string-escapes.sqllogic:13` (`json_quote('String "\\ Test')`), pre-existing on `main` and unrelated — confirmed by stashing these changes and re-running. With the changes restored, mocha reaches further into the suite (87 more tests run before the bail) without further regressions.

## Review focus

- Confirm the `AliasedScope` wrap in `update.ts` / `delete.ts` mirrors the SELECT pattern in `select.ts:registerColumnScope` (parentName = alias = lowered table name). Watch for schema-qualified resolution (`main.tablename.column`): `AliasedScope`'s 3-part branch replaces alias with parentName, then asks the parent — since the parent only registers unqualified column names, this won't resolve, but that's the same behavior SELECT exhibits today and out of scope for this ticket.
- Confirm RETURNING's existing `returningScope` (which already registers both unqualified and `tableName.column` forms) is unaffected: the new `tableScope` is the **parent** of `returningScope`, so RETURNING's scope still wins for unqualified lookups, and qualified lookups for the DML target now resolve through the new wrapper as a side effect — desirable, and matches SELECT.
- Confirm the `await` added to `emitUpdate`'s Phase 1 doesn't impair throughput for the common literal-assignment case (sync values: `await` on a non-Promise value is effectively a microtask; not measured but unlikely to matter in this generator-driven path).
- Confirm there are no other DML emitters (INSERT VALUES with scalar subqueries, UPSERT DO UPDATE assignments in `dml-executor.ts`) that have the same missing-await bug. UPSERT assignments at `dml-executor.ts:97-104` build evaluators the same way; if that path is exercised with scalar subqueries it could exhibit the same defect — not in scope here, but worth a follow-up search.
