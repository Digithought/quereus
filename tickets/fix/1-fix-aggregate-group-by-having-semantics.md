description: Five related deficits in GROUP BY / HAVING / aggregate-binding planner paths
prereq:
files:
  packages/quereus/test/logic/07.3-group-by-extras.sqllogic
  packages/quereus/test/logic/25.1-nested-aggregates.sqllogic
  packages/quereus/test/logic/25.2-having-edge-cases.sqllogic
  packages/quereus/test/logic/26.2-left-join-on-vs-where.sqllogic
  packages/quereus/src/planner/building/select.ts
  packages/quereus/src/planner/building/
----
## Problem

Five distinct aggregate-query deficits, grouped here because they all live in the
GROUP BY / HAVING / aggregate-binding code path during select building and likely
share root causes (scope / alias / aggregate-context handling around the
group-by/having/order-by stages). The implementer is free to split this into
multiple implement-stage tickets if root-cause analysis shows the bugs diverge.

**(a) GROUP BY ordinal not supported.** `group by 1` (and `group by 1, 2`) is
not treated as a positional reference into the SELECT list. Instead the planner
treats the integer literal as a constant grouping key and then reports
`Cannot mix aggregate and non-aggregate columns` because the actual select-list
columns aren't recognised as grouped. Same failure mode when the ordinal form
is combined with HAVING or with ORDER BY ordinal on the aggregate alias.

**(b) Aggregate in ORDER BY rejected even with GROUP BY present.** `order by
count(*) desc` (or any aggregate expression) on a query that has a GROUP BY
fails with `Aggregate function count not allowed in this context`. Aggregate
expressions in ORDER BY are valid SQL when the query is itself an aggregate
query and should be permitted (post-aggregation sort).

**(c) Inner HAVING ignored when subquery feeds outer aggregate.** When a
derived-table subquery containing `group by ... having ...` is wrapped by an
outer aggregate, the inner HAVING predicate is not applied — the outer
aggregate sees all groups instead of only the surviving ones. Output is the
unfiltered aggregate (e.g. 150 instead of 120).

**(d) HAVING accepts ungrouped non-aggregate column.** `select grp from hu
group by grp having id > 0` is silently accepted. Per SQL semantics a HAVING
predicate may only reference grouped columns or aggregate expressions; bare
references to non-grouped columns must be rejected.

**(e) GROUP BY + HAVING drops projection aliases.** When a SELECT with GROUP
BY also has HAVING, projection aliases are stripped: the alias does not appear
in the output column names, and is not visible to ORDER BY. Without HAVING (or
without GROUP BY) the aliases survive normally.

## Expected behavior

(a) `group by N` (integer literal in GROUP BY) acts as a 1-based positional
reference into the SELECT list, matching SQLite (and the existing parallel
support for `order by N`). Out-of-range / zero / negative ordinals should
error.

(b) Aggregate functions are legal in the ORDER BY of a query with a GROUP BY
(or with bare aggregates on a single implicit group). The planner already
threads aggregate expressions into the aggregation step for the SELECT list and
HAVING; ORDER BY needs the same treatment.

(c) HAVING inside a derived-table subquery is part of that subquery's
aggregation step and must filter groups before the rows are exposed to any
outer query (aggregate or otherwise).

(d) HAVING references must resolve only to (i) GROUP BY expressions, (ii) the
implicit group when no GROUP BY is present, or (iii) aggregate expressions over
the input. Non-grouped, non-aggregated column references must be rejected with
a clear error naming the offending column.

(e) Projection aliases declared in the SELECT list of a GROUP BY + HAVING
query must (i) appear as the output column names and (ii) be resolvable by
ORDER BY just as they are in non-HAVING queries.

## Reproduction

All cases are present in the test suite as commented-out queries marked
`-- TODO bug:` (or noted in adjacent comments). Uncomment to observe the
failure.

**(a) GROUP BY ordinal** — `packages/quereus/test/logic/07.3-group-by-extras.sqllogic`
- lines 13-15: `group by 1`
- lines 17-19: `group by 1, 2`
- lines 38-40: `group by 1 having count(*) > 2 order by 1`
- lines 42-44: `group by 1 order by 2 desc`

**(b) Aggregate in ORDER BY with GROUP BY** —
`packages/quereus/test/logic/07.3-group-by-extras.sqllogic` lines 64-70:
`... group by case ... order by count(*) desc, ...`

**(c) Inner HAVING ignored** —
`packages/quereus/test/logic/25.1-nested-aggregates.sqllogic` lines 43-49:
`select sum(s) ... from (select grp, sum(val) as s from na group by grp having sum(val) > 25)`
returns 150 instead of 120.

**(d) HAVING accepts ungrouped column** —
`packages/quereus/test/logic/25.2-having-edge-cases.sqllogic` lines 59-62:
`select grp from hu group by grp having id > 0` is accepted; should error on `id`.

**(e) GROUP BY + HAVING drops projection alias** —
`packages/quereus/test/logic/26.2-left-join-on-vs-where.sqllogic` line 41-43:
the live test on line 42 currently asserts `{"id":1,...}` instead of the
expected `{"lid":1,...}` because the alias `lid` is dropped from the output
when HAVING is present (and is not visible in ORDER BY either).

## Likely investigation areas

- `packages/quereus/src/planner/building/select.ts` — main SELECT builder;
  GROUP BY, HAVING, ORDER BY, and aggregate-binding stages all live here or
  in helpers it calls.
- Aggregate-context tracking: where the builder decides whether an expression
  is being built "inside an aggregate query" (controls whether aggregate calls
  are legal and which references are allowed).
- Ordinal-reference resolution: there is presumably an existing helper for
  `order by <int-literal>`; GROUP BY needs to use the same path (or refuse to
  treat integer literals as constant grouping keys).
- HAVING scope construction: must restrict bare column references to GROUP BY
  outputs (cf. bug d) and must not be discarded when the surrounding select
  also produces a derived table for an outer query (cf. bug c).
- Projection-alias propagation through the aggregation step (cf. bug e) — the
  HAVING-present path likely rebuilds the projection from the aggregate node's
  attributes and loses the user-supplied aliases.
