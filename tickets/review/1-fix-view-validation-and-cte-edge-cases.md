description: Review view column-list arity, CTE-in-VIEW body, recursive CTE LIMIT, and CTE column-count mismatch fixes
prereq:
files:
  packages/quereus/src/parser/parser.ts
  packages/quereus/src/planner/building/create-view.ts
  packages/quereus/src/planner/building/with.ts
  packages/quereus/src/planner/nodes/recursive-cte-node.ts
  packages/quereus/src/runtime/emit/recursive-cte.ts
  packages/quereus/test/logic/08.1-view-edge-cases.sqllogic
  packages/quereus/test/logic/13.4-cte-extras.sqllogic
  packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic
----
## Summary

Closed four small validation/execution gaps around DDL/CTE handling.

### 1. View column-list arity check at DDL time

`buildCreateViewStmt` (`src/planner/building/create-view.ts`) now plans the
view's SELECT body when an explicit column list is provided and rejects the
DDL when the declared arity differs from the projection arity. Previously the
mismatch was silently accepted (or — when the declared list was *shorter* than
the SELECT — caught only at usage time and only in one direction).

### 2. CREATE VIEW body may begin with a WITH clause

`createViewStatement` in `src/parser/parser.ts` now optionally consumes a
`WITH` clause between `AS` and `SELECT`, attaches it to the inner select stmt,
and threads it through to `selectStatement`. The `selectToString` stringifier
already knew how to emit `with` from a SelectStmt, so the rebuilt SQL stored
on `CreateViewNode.sql` is correct.

### 3. Recursive CTE LIMIT honored as early-termination bound

`buildRecursiveCTE` (`src/planner/building/with.ts`) now extracts
`selectStmt.limit`/`offset` from the outer compound select, strips them from
the base-case AST (so they don't double-apply to just the base case), and
passes them as `ScalarPlanNode`s to `RecursiveCTENode`. The node carries them
as additional optional children (visible via `getChildren`/`withChildren`).

`emitRecursiveCTE` (`src/runtime/emit/recursive-cte.ts`) evaluates LIMIT/OFFSET
at run time and bounds yields by a `tryYield` gate that:
- skips the first OFFSET produced rows, and
- stops the iteration as soon as the consumer has been given LIMIT rows.

The infinite-recursion safety check is suppressed when LIMIT was satisfied
(otherwise stopping early would look like exhaustion-by-cap).

### 4. CTE column-count mismatch validated

Both `buildCommonTableExpr` and `buildRecursiveCTE` (in
`src/planner/building/with.ts`) now error when the declared column list
length differs from the inner SELECT projection arity (matching SQLite).

## Test cases enabled

- `test/logic/08.1-view-edge-cases.sqllogic:43-46` — `create view cr_bad (a, b) as select id, name, val from cr_base` is now an error.
- `test/logic/13.4-cte-extras.sqllogic` — recursive CTE with `limit 5` produces exactly 5 rows; `create view cte_view as with positives as (...) select ... from positives` parses and queries correctly; `with bad(a, b) as (select 1) select * from bad` errors.
- `test/logic/41.3-alter-rename-propagation.sqllogic:106-118` — TODO comment updated; the test remains commented because rename propagation through views is independently unimplemented (out of scope).

## Validation done

- `npx tsc --noEmit` — clean
- `yarn lint` — clean
- `yarn test` — 596 passing (same as baseline). The single pre-existing failure
  (`18-json-string-escapes.sqllogic:13`, unrelated `json_quote` escaping) is
  reproduced on a clean checkout and is not introduced by this change.

## Review notes

- Verify the `tryYield` early-termination still cleans up `tableContexts` —
  the `try/finally` in the recursion loop should always release the
  `tableDescriptor` slot even when `break` exits the inner `for await`.
- Confirm that planning the view's SELECT inside `buildCreateViewStmt` for the
  arity check has no side effects (it just walks the AST and resolves
  references; no schema mutation). The plan node is otherwise discarded; only
  `getAttributes().length` is read.
- For recursive CTE LIMIT, the gate counts rows that survive the UNION
  DISTINCT dedup tree (i.e., user-visible output), which matches SQLite. OFFSET
  applies after dedup, before LIMIT.
- `RecursiveCTENode.getChildren`/`withChildren` now have variable arity (2..4
  children depending on whether LIMIT/OFFSET were specified). Optimizer rules
  that touch recursive-CTE children should still work because they preserve
  ordering and the node fixes up its limit/offset slots in `withChildren`.
