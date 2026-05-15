---
description: Soundness fix — `tableSchemaToRelationType` must not promote a partial UNIQUE constraint (one with `uc.predicate`) to a relation-level key, because the FD layer then derives `K → all-other-cols` for the *whole* table. Downstream rules (DISTINCT elimination, GROUP BY simplification, ORDER BY pruning, FK→PK join elimination, predicate-inference equivalence classes) read that FD and silently produce wrong results for rows outside the partial scope. Drop partial-UC entries from the keys list; this is the safety stop-gap. Realizing the (real) optimization opportunity of partial UNIQUEs lives in a separate backlog ticket (`fd-conditional-fd-from-partial-unique-index`).
files:
  packages/quereus/src/planner/type-utils.ts
  packages/quereus/src/planner/nodes/reference.ts
  packages/quereus/src/schema/table.ts
  packages/quereus/test/logic/10.5.1-partial-indexes.sqllogic
  packages/quereus/test/logic/10.6-distinct-edge-cases.sqllogic
---

## Background

See parent fix ticket (now deleted) for the full root-cause writeup. Summary:

`tableSchemaToRelationType` (`packages/quereus/src/planner/type-utils.ts:41-48`)
currently gates UNIQUE-as-key only on NOT NULL-ness:

```ts
if (tableSchema.uniqueConstraints) {
  for (const uc of tableSchema.uniqueConstraints) {
    const allNotNull = uc.columns.every(idx => tableSchema.columns[idx]?.notNull);
    if (allNotNull) {
      keys.push(uc.columns.map(idx => ({ index: idx })));
    }
  }
}
```

`UniqueConstraintSchema.predicate` (`packages/quereus/src/schema/table.ts:436-440`)
already carries the partial-index WHERE for UCs that were synthesized from
`CREATE UNIQUE INDEX … WHERE …`. The fix is to additionally require
`uc.predicate === undefined`.

`TableReferenceNode.computePhysical` (`packages/quereus/src/planner/nodes/reference.ts:81-101`)
materializes `relType.keys` into FDs unconditionally. Once the bad keys are
removed at the source, every downstream rule (consumers listed in the parent
ticket) becomes sound automatically — no per-rule change needed.

## Repro (also the regression test)

```sql
create table t (id integer primary key, c text not null, status text not null);
create unique index ix on t(c) where status = 'active';
insert into t values (1, 'A', 'active');
insert into t values (2, 'A', 'inactive');

-- Before fix: returns 1 row (DISTINCT eliminated; wrong).
-- After fix: returns 2 rows {c:'A'} once, then... actually 1 row — DISTINCT collapses.
-- Wait: see "Test wording" below — the correct expectation is **one** row of c='A',
-- but the bug is that DISTINCT was eliminated and we got both base rows back.
select distinct c from t;
```

The user-visible symptom is "Row count mismatch. Expected 1, got 2": when
DISTINCT is erroneously eliminated, both base rows reach the result, giving
2 rows; the correct DISTINCT output is 1.

## Tests to add

Place under `packages/quereus/test/logic/10.5.1-partial-indexes.sqllogic`
(the partial-index fixture). Add a new section after section 5:

```sqllogic
-- =====================================================
-- 6. Partial UNIQUE index must NOT register as a relation key
-- (FD-layer soundness — see fix ticket fd-partial-unique-index-treated-as-unconditional-key)
-- =====================================================
create table p_fdkey (id integer primary key, c text not null, status text not null);
create unique index ix_p_fdkey on p_fdkey(c) where status = 'active';
insert into p_fdkey values (1, 'A', 'active');
insert into p_fdkey values (2, 'A', 'inactive');
insert into p_fdkey values (3, 'B', 'active');

-- DISTINCT must not be eliminated: c is only unique among status='active' rows.
select c from (select distinct c from p_fdkey) order by c;
→ [{"c":"A"},{"c":"B"}]

-- Same query, count form — must equal the true distinct count across all rows.
select count(*) as n from (select distinct c from p_fdkey);
→ [{"n":2}]

-- LEFT JOIN whose right side is the partial-UNIQUE column: join elimination must
-- not fire — t.c is not an unconditional key, so the join can change row count.
create table p_fdkey_drv (x integer primary key, c text);
insert into p_fdkey_drv values (10, 'A');
select count(*) as n from p_fdkey_drv d left join p_fdkey t on d.c = t.c;
→ [{"n":2}]

drop table p_fdkey_drv;
drop table p_fdkey;
```

(If the host harness rejects subquery-as-FROM in those exact forms, swap to
`select count(distinct c) from p_fdkey` — same intent. Verify against an
existing test that uses the construct you pick.)

Also add a positive control next to it: a *full* UNIQUE index on a NOT NULL
column on the same table shape *does* still eliminate DISTINCT (so we
haven't regressed the happy path). Pattern:

```sqllogic
create table p_fdkey_full (id integer primary key, c text not null);
create unique index ix_p_fdkey_full on p_fdkey_full(c);
insert into p_fdkey_full values (1, 'A');
insert into p_fdkey_full values (2, 'B');
-- DISTINCT should be eliminated; result is the base rows in some order.
select count(*) as n from (select distinct c from p_fdkey_full);
→ [{"n":2}]
drop table p_fdkey_full;
```

The optimizer test directory (`packages/quereus/test/optimizer/`) is also a
candidate if you want a plan-level assertion that the `Distinct` node is/isn't
collapsed; sqllogic on result counts already pins the user-visible semantics,
so optimizer-plan tests are optional.

## TODO

- Edit `relationTypeFromTableSchema` in `packages/quereus/src/planner/type-utils.ts` so the `allNotNull` block additionally requires `uc.predicate === undefined`. One-liner; keep the comment but extend it to mention partial UNIQUEs.
- Add the new section (6 + positive control) to `packages/quereus/test/logic/10.5.1-partial-indexes.sqllogic`.
- Run `yarn workspace @quereus/quereus run test 2>&1 | tee /tmp/test.log; tail -n 80 /tmp/test.log`. Confirm the new section passes and nothing else regresses. Pay attention to anything under `test/optimizer/` or `test/planner/` that asserts plan shapes around DISTINCT / GROUP BY / join elimination — those should still pass because the only behavior change is "partial UNIQUE no longer claims unconditional uniqueness", which was unsound.
- Run `yarn workspace @quereus/quereus run lint 'src/**/*.ts'` (Windows: single-quote the glob per AGENTS.md).
- Out of scope here: the conditional-FD optimization. See `tickets/backlog/fd-conditional-fd-from-partial-unique-index.md`.
- Hand off to review with: the change is one predicate in the UC→keys filter; soundness restored for every downstream consumer of `RelationType.keys` and the table-reference-derived FDs; no new public surface.
