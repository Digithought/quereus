description: ORDER BY integer literal treated as a constant expression instead of a positional reference into the SELECT list
prereq:
files:
  packages/quereus/test/logic/28.2-orderby-expression-extras.sqllogic
  packages/quereus/test/logic/90.6-select-error-paths.sqllogic
  packages/quereus/src/planner/building/select.ts
----

## Problem

An integer literal in `ORDER BY` (e.g. `order by 1`) is treated as the constant value `1`, not as a positional reference to the first column of the SELECT list. As a result:

- The query "succeeds" but doesn't sort the way SQLite (and the SQL standard) specifies.
- Out-of-range, zero, or negative ordinals are silently accepted instead of raising an error. The error-assertion cases in `90.6-select-error-paths.sqllogic` had to be removed because the engine doesn't reject them.

## Expected behavior

Per SQL: an integer literal in an `ORDER BY` term references the SELECT-list column at that 1-based position. Examples:

```
select a from ob order by 1;
-- equivalent to: select a from ob order by a;

select c, a from ob order by 1, 2 desc;
-- equivalent to: order by c, a desc

select abs(x - 5) as dist from many order by 1;
-- equivalent to: order by dist
```

Out-of-range positions (`order by 0`, `order by -1`, `order by 99` when only N columns are projected) must raise an error, not be silently treated as constants.

A non-integer literal or any expression that is not a bare integer literal at parse time keeps current "expression" semantics — only literal integer ordinals trigger positional resolution.

## Reproduction

`-- TODO bug:` markers in `packages/quereus/test/logic/28.2-orderby-expression-extras.sqllogic`:

- line 17 — `select a from ob order by 1;`
- line 24 — `select c, a from ob order by 1, 2 desc;`
- line 85 — `select abs(x - 5) as dist from many order by 1;`

Each is followed by an expected result row and an equivalent non-positional query that currently passes.

Also: `packages/quereus/test/logic/90.6-select-error-paths.sqllogic` previously had error-assertion cases for out-of-range positional ORDER BY that had to be deleted because the engine accepted them silently. Re-add coverage once positional ORDER BY is implemented.

## Likely investigation areas

- `packages/quereus/src/planner/building/select.ts` — ORDER BY building path. Look for the place that walks ORDER BY expressions and either lifts a literal-integer expression into a positional binding to the SELECT list, or (currently) builds it as an arbitrary expression node. The fix likely lives at the same point alias-name resolution against the SELECT list happens.
