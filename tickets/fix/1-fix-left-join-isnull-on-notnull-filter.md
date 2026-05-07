description: LEFT JOIN with a `WHERE <right-side> IS NULL` filter over a NOT NULL right-side column collapses to wrong row count — predicate appears to bypass the join's null-padding step.
prereq:
files:
  packages/quereus/test/logic/26.1-left-join-isnull-on-notnull.sqllogic
  packages/quereus/src/planner/building/select.ts
  packages/quereus/src/planner/building/where-builder.ts
  packages/quereus/src/planner/optimization/predicate-pushdown.ts
----

## Problem

The "anti-join via LEFT JOIN + WHERE x IS NULL" idiom returns the wrong
row count when the right-side column is declared NOT NULL.

Reproducer (`packages/quereus/test/logic/26.1-left-join-isnull-on-notnull.sqllogic`,
line 14):

```sql
create table lj_t1 (a integer primary key, b text);
create table lj_t2 (c integer not null, d integer not null);
insert into lj_t1 values (1, 'x'), (2, 'y'), (3, 'z');
insert into lj_t2 values (1, 10), (2, 20);
select count(*) as cnt from lj_t1 left join lj_t2 on a = c where d is null;
-- expected: [{"cnt":1}]
-- actual:   [{"cnt":3}]
```

`lj_t1` has 3 rows; `lj_t2.c` matches `lj_t1.a` for `a ∈ {1,2}`. The
LEFT JOIN should emit:

- `(a=1, c=1, d=10)` — matched
- `(a=2, c=2, d=20)` — matched
- `(a=3, c=NULL, d=NULL)` — unmatched, right side null-padded

The `WHERE d IS NULL` filter then keeps only the third row → `cnt = 1`.

Lamina backend returns `3`, suggesting the planner is either:

- pushing `d IS NULL` below the LEFT JOIN so it evaluates against
  `lj_t2.d` (declared NOT NULL → predicate trivially false → filter
  drops every row, but then the count over zero rows is `0`, not `3`);
- collapsing the LEFT JOIN to an INNER JOIN AND ignoring the predicate
  entirely (count of 3 is the size of `lj_t1`); or
- treating the predicate as unconditionally true on the join output.

A return of `3` (not `0` and not `2`) is the diagnostic: the planner is
producing all rows of `lj_t1` and applying neither the join's match
filter nor the WHERE's IS NULL filter. The most likely shape is a
join-collapse + predicate-drop driven by the NOT NULL declaration on
`d` — the predicate-pushdown pass may be using "column is NOT NULL →
`x IS NULL` is always false" to constant-fold the WHERE, then a
separate LEFT-to-INNER conversion fails to detect that the now-vacuous
predicate originally guarded null-padded rows from a LEFT JOIN.

## Expected behavior

LEFT JOIN with a `WHERE <right-side-col> IS NULL` filter must operate
on the post-null-padded join output. The `IS NULL` predicate against a
NOT NULL column is *only* false against rows where the column came
from the source table — it is true for null-padded rows that the LEFT
JOIN emits for unmatched left rows. Optimisations that drop the
`IS NULL` predicate based on declared nullability must not apply to
right-side columns of a LEFT JOIN unless the predicate is recognised as
the anti-join idiom and the join is correspondingly converted (or left
as LEFT JOIN with the predicate retained at the WHERE stage).

## Reproduction

```
cd packages/quereus
yarn test packages/quereus/test/logic/26.1-left-join-isnull-on-notnull.sqllogic
```

Expected to fail at line 14 with `cnt: 3` instead of `cnt: 1`. The same
file's later cases (lines 18 and 23) test `ON IS NULL against NOT NULL`
and constant-NULL ON predicates; verify those when the WHERE-based
case is fixed.

## Cross-references

The corpus file was added under `tickets/complete/5-sqlite-xref-joins.md`'s
xref pass with the note "new fixtures will likely fail until engine
work catches up — that is expected". This ticket is that follow-up.

Surfaced via lamina-quereus-test sqllogic harness; tracked there as
`quereus/fix-left-join-isnull-on-notnull-filter` in
`packages/lamina-quereus-test/src/sqllogic/known-failures.ts`.
