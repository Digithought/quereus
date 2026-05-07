description: Preserve SELECT-list aliases on grouped column references in GROUP BY queries
prereq:
files:
  packages/quereus/src/planner/building/select.ts
  packages/quereus/src/planner/building/select-aggregates.ts
  packages/quereus/src/planner/nodes/aggregate-node.ts
  packages/quereus/test/logic/26.2-left-join-on-vs-where.sqllogic
  packages/quereus/test/logic/25.1-nested-aggregates.sqllogic
----

## Problem

When a SELECT with GROUP BY projects a grouped column with an alias (`select ow_l.id as lid, count(ow_r.id) as cnt … group by ow_l.id`), the alias `lid` is silently dropped from the output column name (the row comes back as `id` instead of `lid`). The original ticket framed this as HAVING-specific, but reproduction shows it happens **whenever GROUP BY is present** and the grouped column is projected with an alias.

Aggregate aliases survive (`count(ow_r.id) as cnt` → `cnt`) because they're built via the aggregate path. The problem is specific to plain column references that match a GROUP BY key.

```sql
-- broken: alias dropped
select grp as g, count(*) as cnt from gx group by grp;
-- output: {grp: …, cnt: …}    expected: {g: …, cnt: …}

-- broken (the 26.2 case): alias dropped, with or without HAVING
select ow_l.id as lid, count(ow_r.id) as cnt
from ow_l left join ow_r on ow_l.id = ow_r.l_id
group by ow_l.id [having count(ow_r.id) > 0]
order by ow_l.id;
-- output: {id: …, cnt: …}    expected: {lid: …, cnt: …}
```

## Root cause

In `select.ts:139-152`, the final ProjectNode is only added when `aggregateResult.needsFinalProjection` is true:

```ts
if (aggregateResult.needsFinalProjection && aggregateResult.aggregateNode && aggregateResult.groupByExpressions) {
  const finalProjections = buildFinalAggregateProjections(…);
  input = new ProjectNode(selectScope, input, finalProjections, undefined, undefined, preserveForAggregate);
}
```

`needsFinalProjection` is computed by `checkNeedsFinalProjection` (`select-aggregates.ts:347-357`):

```ts
return projections.some(proj => !CapabilityDetectors.isColumnReference(proj.node));
```

So when every projection is a simple column reference (e.g., the only non-aggregate SELECT item is the GROUP BY column), no final projection is added. The output names then come from `AggregateNode.buildOutputType()` (`packages/quereus/src/planner/nodes/aggregate-node.ts:52-67`) which uses `getGroupByColumnName` (`aggregate-node.ts:42-50`) — that returns the *original column name* (`colRef.expression.name`), not the SELECT-list alias.

Aggregate columns are unaffected because their AggregateNode output name IS the alias (`agg.alias`).

## Expected behavior

A SELECT-list alias on any projection (including a simple column reference that matches a GROUP BY key) survives to the output column names AND to subsequent ORDER BY / outer-query references.

## Implementation approach

Force a final projection whenever any projection has an alias different from its underlying column name. Smallest change:

1. In `select-aggregates.ts:347-357`, broaden `checkNeedsFinalProjection`:

   ```ts
   function checkNeedsFinalProjection(projections: Projection[]): boolean {
     if (projections.length === 0) return false;
     return projections.some(proj => {
       // Non-trivial expression — always needs the projection.
       if (!CapabilityDetectors.isColumnReference(proj.node)) return true;
       // Simple column ref — needs projection if the alias renames it.
       const underlyingName = (proj.node as ColumnReferenceNode).expression.name.toLowerCase();
       return Boolean(proj.alias && proj.alias.toLowerCase() !== underlyingName);
     });
   }
   ```

2. `buildFinalAggregateProjections` (`select-aggregates.ts:470-517`) already preserves `column.alias`, so the existing path handles the alias once we force it on. No change there.

3. Verify the `preserveForAggregate` flag (`select.ts:150`) interacts correctly. Since `hasHavingOnlyAggregates` already triggers final projection with `preserveForAggregate=false` (strip extra aggregates), make sure the new alias-driven final-projection path uses `preserveForAggregate=preserveInputColumns` (the default for top-level queries) so it doesn't accidentally strip useful columns.

4. There is a related symptom worth checking: if GROUP BY uses a complex expression aliased in SELECT (`select grp || sub as combined, sum(val) … group by grp || sub`), the existing fingerprint-match path keeps it in `projections` (non-column-ref → already triggers final projection). That path should remain unchanged; the test in `07.3-group-by-extras.sqllogic:29-31` already covers it.

## Test corrections (bug "(c)" reframe)

Investigation showed the bug-(c) reproduction in the source ticket — `25.1-nested-aggregates.sqllogic:43-49` — is a **bad test**, not a real engine bug. With `having sum(val) > 25` against the data (group sums 30, 70, 50), all groups satisfy and the outer sum should be **150**, not 120. HAVING IS being applied through the derived table; with a discriminating threshold (e.g. `> 35`, eliminating group 'a'=30) the engine correctly produces total=120.

While here, replace the commented-out `-- TODO bug` block in `25.1-nested-aggregates.sqllogic:43-49` with a positive test using a discriminating threshold:

```sql
-- HAVING inside a derived-table feeding an outer aggregate filters groups correctly.
-- Group sums: a=30, b=70, c=50; threshold > 35 keeps b and c → outer sum = 120.
select sum(s) as total_above_threshold
from (select grp, sum(val) as s from na group by grp having sum(val) > 35);
→ [{"total_above_threshold":120}]
```

This serves as regression coverage that HAVING propagates through derived tables.

## Tests to enable / add

Update `packages/quereus/test/logic/26.2-left-join-on-vs-where.sqllogic`:

- The live test on line 42 currently asserts `{"id":1,…}` (the buggy output). After the fix, change the expectation to `{"lid":1,…}` and remove the `-- TODO bug:` note on line 41.

Add new positive coverage:

- `select grp as g, count(*) as cnt from gx group by grp order by g;` — alias survives, ORDER BY can use the alias.
- `select grp as g, count(*) as cnt from gx group by grp having count(*) > 0 order by g;` — same with HAVING.
- `select t.col as alias_only from t group by t.col;` — minimal repro form.

Replace the commented-out block in `25.1-nested-aggregates.sqllogic` (see "Test corrections" above) with the discriminating-threshold positive test.

## Acceptance

- `yarn build`, `yarn test`, and `yarn lint` (in `packages/quereus`) pass.
- The 26.2 line-42 test, updated to expect `lid`, passes.
- The new 25.1 positive test (corrected threshold) passes.
- New positive tests pass.

## TODO

- Broaden `checkNeedsFinalProjection` in `select-aggregates.ts` to also force a final projection on alias renames.
- Confirm `preserveForAggregate` is correct for the new alias-only final-projection path.
- Update 26.2 line-42 expectation from `{"id":…}` to `{"lid":…}` and remove its TODO note.
- Replace the commented-out 25.1 lines 43-49 block with the discriminating-threshold positive test.
- Add the new positive sqllogic coverage above.
