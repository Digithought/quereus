description: View column-list arity, CTE-in-VIEW body, recursive CTE LIMIT, and CTE column-count mismatch validation gaps
prereq:
files:
  packages/quereus/test/logic/08.1-view-edge-cases.sqllogic
  packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic
  packages/quereus/test/logic/13.4-cte-extras.sqllogic
  packages/quereus/src/planner/building/create-view.ts
  packages/quereus/src/planner/building/select.ts
  packages/quereus/src/runtime/emit/recursive-cte.ts
  packages/quereus/src/parser/parser.ts
----
## Problem

Several DDL/CTE validation paths silently accept malformed input or ignore execution-shaping clauses. Grouped here because each touches schema/CTE validation and is small.

- **View column-list rename with mismatched arity** is silently accepted. SQLite rejects when the declared column-list arity differs from the SELECT projection arity.
- **CREATE VIEW does not accept a leading `with` (CTE) in the body**. Quereus' parser only accepts a bare SELECT after `as`, so views cannot wrap a CTE.
- **Recursive CTE `limit N`** inside the CTE body is not honored as an early-termination bound. Recursion runs to its WHERE-clause cutoff (or the internal 1000-row safety limit) instead of stopping after N output rows.
- **CTE column-count mismatch** (`with bad(a, b) as (select 1)`) is silently accepted; declared column list and SELECT projection should be required to match in arity.

## Expected behavior

- `create view v(a, b) as select 1, 2, 3` — error at DDL: declared column list (2) does not match SELECT arity (3).
- `create view v as with c as (select ...) select ... from c` — accepted; view body may be a `with`-prefixed select.
- A `limit N` inside a recursive CTE's compound term must bound total output rows; once N rows have materialised, recursion stops (no further iterations are performed).
- `with bad(a, b) as (select 1) select * from bad` — error at planning: declared column list (2) does not match SELECT arity (1).

## Reproduction

Uncomment to observe the failures:

- `packages/quereus/test/logic/08.1-view-edge-cases.sqllogic:43-46` — view column-list arity mismatch silently accepted.
- `packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic:106-114` — CTE inside CREATE VIEW body rejected by parser ("Expected 'SELECT' after 'AS' in CREATE VIEW"); rename propagation through the view is also unimplemented.
- `packages/quereus/test/logic/13.4-cte-extras.sqllogic:39-48` — recursive CTE `limit 5` not honored.
- `packages/quereus/test/logic/13.4-cte-extras.sqllogic:80-87` — CTE column-count mismatch silently accepted.
- Adjacent context at `packages/quereus/test/logic/13.4-cte-extras.sqllogic:64-77` — CREATE VIEW with `with` body rejected by parser (same root cause as the 41.3 case).

## Likely investigation areas

- `packages/quereus/src/planner/building/create-view.ts` — declared column-list arity check against the resolved projection; whether the parser entry permits a `with`-prefixed body.
- `packages/quereus/src/parser/parser.ts` — `create view ... as` production currently dispatches into a SELECT-only parse; needs to allow an optional leading `with` (and likely defer to the same statement-body parser used for top-level CTE-prefixed selects).
- CTE building (search `select.ts` for the `with` clause handling) — declared column-list arity validation against the inner SELECT.
- `packages/quereus/src/runtime/emit/recursive-cte.ts` — propagate an outer `limit` into the iteration loop as an early-exit condition.
