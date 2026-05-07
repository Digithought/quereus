description: Outer DML target table not visible to correlated subqueries in UPDATE SET / WHERE and DELETE WHERE
prereq:
files:
  packages/quereus/test/logic/07.6.1-subquery-extras.sqllogic
  packages/quereus/test/logic/01.6-update-extras.sqllogic
  packages/quereus/test/logic/01.8-delete-extras.sqllogic
  packages/quereus/src/planner/building/update.ts
  packages/quereus/src/planner/building/delete.ts
  packages/quereus/src/planner/scopes/
----

## Problem

When a correlated subquery references the DML target table inside an UPDATE SET expression, an UPDATE WHERE clause, or a DELETE WHERE clause, the planner fails to resolve the outer table's columns. The error surfaces as "<table>.<col> isn't a column", indicating the outer DML target table is missing from the scope chain seen by the nested subquery builder.

This affects scalar subqueries in UPDATE SET, EXISTS / NOT EXISTS in DELETE WHERE, and self-correlated EXISTS over the same DML target (with a different alias inside the subquery).

## Expected behavior

Per SQL semantics, the DML target table (and its alias if any) must be in scope for any correlated subquery in the SET, WHERE, or RETURNING clauses, exactly as it is in plain SELECT contexts. Examples:

```
update sqx_outer set val = (select coalesce(sum(amount), 0)
                            from sqx_inner where sqx_inner.ref_id = sqx_outer.id);

delete from del_parent
 where exists (select 1 from del_child where del_child.parent_id = del_parent.id);

delete from seq
 where exists (select 1 from seq as s2 where s2.x = seq.x + 1);
```

All three should resolve `sqx_outer.id`, `del_parent.id`, and `seq.x` as correlated references to the outer DML target row currently being processed.

## Reproduction

`-- TODO bug:` markers (uncomment the immediately following SQL + expected `→` rows to reproduce):

- `packages/quereus/test/logic/07.6.1-subquery-extras.sqllogic:15` — UPDATE SET correlated scalar subquery (`sqx_outer.id isn't a column`)
- `packages/quereus/test/logic/01.6-update-extras.sqllogic:28` — UPDATE SET correlated scalar subquery (`tgt_lookup.id isn't a column`)
- `packages/quereus/test/logic/01.8-delete-extras.sqllogic:15` — DELETE WHERE EXISTS (`del_parent.id isn't a column`)
- `packages/quereus/test/logic/01.8-delete-extras.sqllogic:32` — DELETE WHERE NOT EXISTS (`orders.customer_id isn't a column`)
- `packages/quereus/test/logic/01.8-delete-extras.sqllogic:89` — DELETE self-correlated EXISTS, same table different alias (`seq.x isn't a column`)

## Likely investigation areas

- `packages/quereus/src/planner/building/update.ts` — scope construction around SET-list and WHERE clause builders; verify the target table's `RelationalScope` (or equivalent) is pushed before subquery building.
- `packages/quereus/src/planner/building/delete.ts` — same for DELETE's WHERE clause.
- `packages/quereus/src/planner/scopes/` — confirm correlated-reference resolution walks parent scopes and that DML builders register the target relation as a parent scope visible to nested subquery builders.
