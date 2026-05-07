description: Self CROSS JOIN with same-table aliases collapses to a single row instead of producing the cartesian product
prereq:
files:
  packages/quereus/test/logic/01.1-select-projection-extras.sqllogic
  packages/quereus/src/planner/building/
----

## Problem

A self CROSS JOIN of the same table under two different aliases (`from t1 as A cross join t1 as B`) does not produce the expected cartesian product — the result collapses to a single row per left-side row (or fewer), and `A.*, B.*` projection emits only one side's columns.

The most likely cause is that the two scans of `t1` end up sharing attribute IDs (or some other per-table identity) so that the join builder treats `B`'s columns as the same attributes as `A`'s, collapsing the join into a self-equijoin on those attributes and squashing the projection wildcard expansion to one side.

## Expected behavior

`A` and `B` are independent relations over `t1`. With `t1` containing rows `(1,'one')` and `(2,'two')`:

```
select A.a as la, B.a as ra from t1 as A cross join t1 as B order by la, ra;
-- → [{"la":1,"ra":1},{"la":1,"ra":2},{"la":2,"ra":1},{"la":2,"ra":2}]

select A.*, B.* from t1 as A cross join t1 as B order by A.a, B.a;
-- → [{"a":1,"b":"one","a:1":1,"b:1":"one"},
--    {"a":1,"b":"one","a:1":2,"b:1":"two"},
--    {"a":2,"b":"two","a:1":1,"b:1":"one"},
--    {"a":2,"b":"two","a:1":2,"b:1":"two"}]
```

Both rows must appear from each side (full cartesian product), and `A.*, B.*` must emit all four columns with `:1` suffix disambiguation as already used for duplicate wildcard expansion (cf. `select *, * from t1` on the same file).

## Reproduction

`-- TODO bug:` markers in `packages/quereus/test/logic/01.1-select-projection-extras.sqllogic`:

- line 23 — self cross join with aliases collapses to a single row instead of cartesian product
- line 27 — `A.*, B.*` across self cross join only emits one side's columns

Each TODO line is followed by the offending SQL (commented) and the expected `→` result.

## Likely investigation areas

- Planner attribute resolution / attribute-ID assignment when the same physical table is scanned twice under different aliases. Each alias must get a fresh set of attribute IDs distinct from the other scan.
- `packages/quereus/src/planner/building/` — `from` / table-reference / join builders, particularly wherever a `TableRef`'s columns are converted into per-instance attributes.
- Wildcard expansion for `<alias>.*` likely uses the same attribute identity, so once the underlying attributes are correctly distinct per alias, the projection bug should disappear too — but verify.
