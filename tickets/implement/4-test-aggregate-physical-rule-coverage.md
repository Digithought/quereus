---
description: Raise branch coverage on `src/planner/rules/aggregate/rule-aggregate-streaming.ts` (currently 70.8% branches — the lowest-covered rules directory). This is the rule that picks between `StreamAggregateNode`, `HashAggregateNode`, and `Sort+StreamAggregate` based on cost, ordering, and grouping-key shape. Each untested branch is a silent wrong-plan bug.
dependencies: plan-shape test harness (already established in test/plan/)
files:
  packages/quereus/src/planner/rules/aggregate/rule-aggregate-streaming.ts
  packages/quereus/src/planner/nodes/stream-aggregate.ts
  packages/quereus/src/planner/nodes/hash-aggregate.ts
  packages/quereus/src/planner/cost/index.ts
  packages/quereus/test/plan/aggregate-physical-selection.spec.ts
  packages/quereus/test/logic/109-aggregate-physical-selection.sqllogic
  packages/quereus/docs/optimizer.md
---

## Context

`ruleAggregatePhysical` (`rule-aggregate-streaming.ts:29`) is the only rule in `src/planner/rules/aggregate/`, and it holds 70.8% branch coverage — the lowest of any rules directory. It has five distinct decision branches:

1. **Not aggregating** → `null` (line 30-32) — no-op for non-aggregate nodes
2. **Not streamable** → `null` (line 41-44) — `canStreamAggregate()` returns false
3. **No GROUP BY** → `StreamAggregate` unconditionally (line 53-59) — scalar aggregate
4. **Already sorted** → `StreamAggregate` unconditionally (line 65-72) — source ordering matches grouping keys
5. **Unsorted, cost comparison** (line 74-102):
   - Hash cheaper → `HashAggregateNode`
   - Sort+stream cheaper → `SortNode + StreamAggregateNode`

The helper `isOrderedForGrouping` (line 111) has its own branches:
- Empty or missing ordering
- Non-column-reference grouping key (e.g. `GROUP BY a + 1`)
- Grouping key whose attribute ID isn't in source
- More grouping keys than ordering entries
- Ordering prefix mismatch (column order differs)

And `combineAttributes` (line 152) has:
- Duplicate name deduplication on both aggregate and source sides

## Scope

Guard every branch with a targeted test that:
- (a) **shouldn't break when someone adds a new branch** — so avoid brittle whole-plan snapshots; prefer targeted assertions on "is this node a `HashAggregateNode`", "does this node have a `SortNode` child"
- (b) **will catch a mutant** — not just "result set is correct"

### Plan-shape tests

Create `test/plan/aggregate-physical-selection.spec.ts` using the existing plan-shape harness (see how `test/plan/` tests invoke the planner and walk the resulting PlanNode tree). One describe block per branch:

```ts
describe('ruleAggregatePhysical', () => {
  it('scalar aggregate picks StreamAggregate regardless of sort state', async () => {
    const plan = await planQuery(db, 'select count(*) from t');
    const top = findNode(plan, (n) => n.nodeType === PlanNodeType.StreamAggregate);
    expect(top).toBeDefined();
    expect(findNode(plan, (n) => n.nodeType === PlanNodeType.HashAggregate)).toBeUndefined();
  });

  it('grouped on already-ordered source picks StreamAggregate without extra SortNode', async () => {
    // t is PK on (a, b) so select ... group by a,b is pre-sorted
    const plan = await planQuery(db, 'select a, b, count(*) from t group by a, b');
    const agg = findNode(plan, (n) => n.nodeType === PlanNodeType.StreamAggregate)!;
    expect(agg.getSource().nodeType).not.toBe(PlanNodeType.Sort);
  });

  it('unsorted source with many distinct groups picks Hash', async () => {
    // large input, small group count → hash cheaper
    await db.exec(`insert into unsorted_t select random(), random() from generate_series(1, 10000)`);
    const plan = await planQuery(db, 'select x, count(*) from unsorted_t group by x');
    expect(findNode(plan, (n) => n.nodeType === PlanNodeType.HashAggregate)).toBeDefined();
  });

  it('unsorted source with few distinct groups picks Sort+Stream', async () => {
    // tune so sort cheaper than hash
    // ...
  });

  it('group by expression (non-column-ref) is not counted as ordered even if source is sorted', async () => {
    // isOrderedForGrouping early-returns false
  });

  it('grouping column not in source ordering prefix → not ordered', async () => {
    // e.g. ordering is (a, b), group by (a, c)
  });
});
```

### Sqllogic integration

`test/logic/109-aggregate-physical-selection.sqllogic` — assert results plus `explain` + `plan like` shape:

```
# Already-sorted path: no sort node inserted
statement ok
create table s(a int primary key, b int);

query T
explain select a, sum(b) from s group by a;
----
plan like %StreamAggregate%
plan notlike %Sort%

# Unsorted + high cardinality → Hash
statement ok
create table u(a int, b int);

statement ok
insert into u values (1,1),(2,2),(3,3),(4,4),(5,5);

query T
explain select a, sum(b) from u group by a;
----
plan like %HashAggregate%
```

Note: the cost-comparison branches (hash vs sort+stream) are the most fragile to test — the decision flips as the cost model evolves. Write these tests with a small tolerance: use `OptimizerTuning` overrides if the test harness supports them, or pick input sizes far from the crossover point so small cost-model changes don't flip which branch wins. Prefer to test these via the unit-level plan-shape tests rather than sqllogic.

## Validation loop

```bash
cd packages/quereus
yarn test
yarn test:coverage
# Check coverage/quereus/src/planner/rules/aggregate/
```

Target: raise `planner/rules/aggregate` branch coverage from 70.8% to ≥90%.

## TODO

- [ ] Study existing plan-shape tests in `test/plan/` to match the harness pattern
- [ ] Create `test/plan/aggregate-physical-selection.spec.ts` with one test per decision branch
- [ ] Cover `isOrderedForGrouping` edge cases: non-column-ref grouping, missing attribute, more keys than ordering, prefix mismatch
- [ ] Cover `combineAttributes` name-dedup on both aggregate and source sides
- [ ] Create `test/logic/109-aggregate-physical-selection.sqllogic` with `plan like` assertions
- [ ] Handle the hash-vs-sort cost crossover carefully — pick inputs far from the threshold or allow either outcome
- [ ] Re-run `yarn test:coverage` and verify threshold met
- [ ] If cost comparison is fragile, file a follow-up ticket to expose optimizer-tuning hooks for deterministic testing
