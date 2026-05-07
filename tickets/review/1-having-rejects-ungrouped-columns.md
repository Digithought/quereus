description: Reject HAVING references to non-grouped, non-aggregated columns
prereq:
files:
  packages/quereus/src/planner/building/select-aggregates.ts
  packages/quereus/test/logic/25.2-having-edge-cases.sqllogic
----

## Summary

`HAVING` no longer silently accepts references to columns that are neither in the `GROUP BY` list nor inside an aggregate function. Such queries now raise:

```
HAVING references non-grouped column '<name>'; HAVING may only reference GROUP BY columns or aggregate expressions
```

This applies in two shapes:
- `GROUP BY` is present — only `GROUP BY` expressions and aggregate expressions are valid in `HAVING`.
- No `GROUP BY` but the query has aggregates (the implicit single group) — only aggregates are valid; bare column references are rejected.

When the query has neither aggregates nor `GROUP BY`, the existing pre-aggregate `HAVING`-as-`WHERE` push-down still applies and bare references remain valid.

## Implementation notes

Centralized in `buildHavingFilter` (`packages/quereus/src/planner/building/select-aggregates.ts`). After the HAVING expression is built against the hybrid scope, the existing `findUngroupedColumnRef` walker scans for `ColumnReferenceNode`s whose attribute id is not allowed and whose enclosing subtree's AST fingerprint does not match a GROUP BY expression.

The "allowed attribute id" set covers two flavors of valid reference:
- Source-side attribute ids of GROUP BY column references — covers the case where the resolver picks a source column that happens to coincide with a GROUP BY key.
- The AggregateNode's first `groupBy.length + aggregates.length` output attribute ids — covers GROUP BY-column resolution through `aggregateOutputScope` and aggregate-function references (`count(*)`, aggregate aliases) which all resolve to AggregateNode-output column refs.

The walker stops descending into aggregate-function subtrees, relational subtrees, and any subtree whose AST fingerprint matches a GROUP BY expression. This preserves the existing fingerprint-match path (e.g. `group by val * 2 having val * 2 > 10`).

## Test cases

`packages/quereus/test/logic/25.2-having-edge-cases.sqllogic` covers:

Negative (error includes the offending column name):
- `select grp from hu group by grp having id > 0;` — bare ungrouped column.
- `select grp, sum(val) from hu group by grp having val > 0;` — ungrouped column alongside an aggregate in SELECT.
- `select grp, sum(val) from hu group by grp having grp = 'a' and val > 0;` — mixed: `grp` is fine, `val` is rejected.
- `select count(*) from hu having id > 0;` — implicit-single-group form.

Positive (still pass):
- `select grp from hu group by grp having sum(val) > 0;` — aggregate.
- `select grp from hu group by grp having grp = 'a';` — GROUP BY column.
- `select val * 2 as v2 from hu group by val * 2 having val * 2 > 30;` — fingerprint-match path.

All existing HAVING tests across the logic suite continue to pass (e.g. `having count(*) > 1`, `having sum(val) + count(*) > 35`, alias references like `having total > 30`, correlated-subquery HAVINGs).

## Validation

- `yarn build` — clean.
- `yarn test` — 2523 passing, 3 pending, 0 failing.
- `yarn lint` — clean.
