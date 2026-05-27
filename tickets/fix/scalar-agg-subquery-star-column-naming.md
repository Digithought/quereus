description: `SELECT *` (and even explicit column refs) over a join of two scalar-aggregate subqueries returns the wrong column for the second subquery — the aliased aggregate output column is relabeled as the inner table's first/PK column. Values are correct; the column name/identity is wrong.
files: packages/quereus/src/planner/building/ (select/from/subquery building), packages/quereus/src/planner/nodes/project-node.ts, packages/quereus/test/optimizer/keys-propagation.spec.ts
----

## Symptom

```sql
-- expected columns: a, b   (values 3, 3)
SELECT * FROM (SELECT count(*) AS a FROM t) x
        CROSS JOIN (SELECT count(*) AS b FROM t) y;
-- actual: { a: 3, id: 3 }   ← second column named `id`, not `b`
```

Reproduces:
- with `*` AND with an explicit `SELECT x.a, y.b` (so it is **not** a `*`-expansion-only
  bug — the explicit `y.b` reference also resolves to the wrong attribute/label).
- with the two subqueries over **different** tables:
  `… CROSS JOIN (SELECT count(*) AS b FROM t2) y` → `{ a: 3, id: 2 }` (value 2 = count(t2)
  is correct, label `id` is wrong).
- regardless of `DISTINCT`.

The aggregate **value** is correct in every case; only the output **column identity /
name** of the second (right-hand) scalar-aggregate subquery is wrong — it surfaces the
inner base table's first column name (`id`) instead of the subquery's projected alias.

## Pre-existing — NOT caused by the empty-key-join-coverage work

Confirmed by reverting `key-utils.ts` + `join-utils.ts` to the parent commit
(`9a4e3a92`): the wrong result reproduces there too. The empty-key/key-FD propagation
work only touches physical FD/key/estimatedRows metadata and cannot affect emitted
column names or values. A non-aggregate subquery cross join
(`SELECT * FROM (SELECT id AS a FROM t) x CROSS JOIN (SELECT v AS b FROM t) y`) projects
correctly, so the defect is specific to **scalar-aggregate** (≤1-row) subqueries used as
a join source — likely scalar-subquery flattening / attribute-id assignment collapsing
the aggregate output attribute onto an inner column.

## Why it matters

Silent wrong-column / wrong-label output is a correctness bug. It is currently masked in
tests because most assertions read by position or re-alias. A reviewer found it via a
behavioral assertion added in `keys-propagation.spec.ts`; that test was rewritten to
compare DISTINCT-vs-plain result-equality (which holds) rather than a hard-coded
`{a,b}` shape, so the suite stays green while this ticket tracks the real defect.

## Repro / acceptance

- `SELECT x.a, y.b FROM (SELECT count(*) AS a FROM t) x CROSS JOIN (SELECT count(*) AS b FROM t2) y`
  must yield a row with columns named exactly `a` and `b`.
- Investigate scalar-aggregate subquery attribute-id / output-attribute assignment when
  the same (or a structurally similar) base table is scanned on both sides — suspect an
  attribute-id collision or a `*`/projection scope resolving to the inner relation.
- Add a behavioral regression in `keys-propagation.spec.ts` (or a sqllogic case)
  asserting correct column names + values for an aggregate-subquery cross join.
