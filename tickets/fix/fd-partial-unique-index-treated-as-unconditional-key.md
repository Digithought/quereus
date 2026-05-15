---
description: `tableSchemaToRelationType` adds every NOT NULL `UniqueConstraintSchema` to `RelationType.keys` without consulting `uc.predicate`. Partial UNIQUE indexes (`create unique index ix on t(c) where ...`) become unconditional keys, so the FD layer derives `c → all-other-cols` for the whole table. Downstream rules (DISTINCT elimination, GROUP BY simplification, join elimination, etc.) then act on a key claim that does not hold for rows outside the partial-index predicate — producing wrong results.
files:
  packages/quereus/src/planner/type-utils.ts
  packages/quereus/src/planner/nodes/reference.ts
  packages/quereus/src/planner/rules/distinct/rule-distinct-elimination.ts
  packages/quereus/src/schema/table.ts
---

## Repro

```sql
create table t (id integer primary key, c text, status text);
create unique index ix on t(c) where status = 'active';
insert into t values (1, 'A', 'active');
insert into t values (2, 'A', 'inactive');

-- Wrong: returns 2 rows. Correct answer is 1 row {"c":"A"} — the partial UNIQUE
-- only covers active rows, so c='A' legitimately appears twice in the table.
select distinct c from t;
```

Verified directly: a sqllogic probe with this exact shape fails with `Row count
mismatch. Expected 1, got 2`. The DISTINCT was eliminated by
`ruleDistinctElimination` because `node.source.getType().keys` reported
`[[c]]` as a key.

## Root cause

`tableSchemaToRelationType` (`type-utils.ts:41-48`):

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

Only nullability is gated. `uc.predicate` (the partial-index WHERE clause,
mirrored from `IndexSchema.predicate` and exposed on
`UniqueConstraintSchema` since the schema layer was extended for this) is
ignored. Quereus columns default to NOT NULL (Third Manifesto), so the gate
trivially passes for typical schemas.

The bogus key flows through:

1. `RelationType.keys` (here)
2. `TableReferenceNode.computePhysical` (`reference.ts:81-100`) → emits one
   `K → other-cols` FD per declared key.
3. `physical.fds` is consumed by `isSuperkey` / `hasAnyKey` (fd-utils.ts)
   and by every rule that uses them: `rule-distinct-elimination`,
   `rule-groupby-fd-simplification`, `rule-orderby-fd-pruning`,
   `rule-join-elimination` (FK→PK matching), `rule-predicate-inference-equivalence`,
   plus `RelationType.keys` is also read directly by `ruleDistinctElimination`
   line 28.

Every consumer treats the FD as unconditional. None of them hold a
predicate to evaluate, so even if they wanted to be careful they could not.

## Why pre-existing yet now urgent

The `uniqueConstraints → keys` line landed in commit `52654836`
(2026-02-23, "key-driven cardinality with FK→PK inference and DISTINCT
elimination") and is on `main`. The bug therefore predates the FD branch,
but the FD branch substantially expanded the set of rules that capitalize
on `RelationType.keys` and the derived FDs. The blast radius today
includes at least: DISTINCT elimination, GROUP BY simplification, ORDER BY
pruning, FK→PK join elimination, and predicate-inference equivalence
classes. All of them act on the over-promised key.

## Two design directions to weigh during plan stage

**(A) Conservative — drop partial constraints from the keys/FD layer.**
Filter out `uc.predicate !== undefined` constraints in
`tableSchemaToRelationType`. Sound and small. Loses the (real) optimization
opportunity below.

**(B) Capitalize properly — emit a *conditional* FD and discharge it when
the query subsumes the predicate.** A partial UNIQUE on `(c) where P`
gives a valid FD `c → all-other-cols` *for any sub-relation whose row
predicate implies P*. To exploit this:

1. Extend `FunctionalDependency` (or an FD wrapper) with an optional
   `condition: ScalarPlanNode` field, or carry the partial keys separately
   as `conditionalKeys: { columns: number[]; predicate: ScalarPlanNode }[]`.
2. At consumption sites that already see a `Filter` above the table
   reference, ask "does the filter's normalized conjunction imply the
   conditional predicate?" If yes, lift the conditional FD to an
   unconditional one for the scope above the filter.
3. Predicate implication is non-trivial in general — ship a syntactic
   check first (literal-equality match on the same expression up to the
   conjunct decomposition the predicate-conjuncts util already does), and
   leave full semantic implication as a follow-up.

(B) is more work but actually realizes the optimizer benefit of partial
UNIQUE indexes. (A) is the safety stop-gap.

A hybrid is reasonable: ship (A) immediately to close the soundness hole,
file a separate plan ticket for (B).

## Tests to add (regardless of direction)

- `select distinct c from t` over the partial-UNIQUE schema above —
  must return 1 row.
- `select count(*) from (select distinct c from t)` — must equal the
  number of distinct c values across the WHOLE table.
- Join elimination: `from a left join t on a.x = t.c` where `t.c` is
  partial UNIQUE — the join must NOT be eliminated.
- (For direction B): the same `select distinct c from t where status = 'active'`
  — distinct *should* be eliminated because the query's filter implies the
  partial-index predicate.

## Out of scope

- The store-side `checkUniqueConstraints`-ignores-`uc.predicate` runtime bug
  (separate ticket: `store-checkuniqueconstraints-ignores-partial-index-predicate`).
- The drop-side schema cleanup (separate backlog ticket
  `schema-manager-drop-index-stale-unique-constraint`).
