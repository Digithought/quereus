description: Serialize Promise.all callback evaluation in returning.ts and window.ts to eliminate the row-context collision class fixed in emitProject
prereq: serialize-project-subquery-evaluation
files:
  packages/quereus/src/runtime/emit/returning.ts
  packages/quereus/src/runtime/emit/window.ts
  packages/quereus/src/runtime/emit/project.ts
  packages/quereus/src/runtime/context-helpers.ts
  packages/quereus/test/logic/42.1-returning-extras.sqllogic
  packages/quereus/test/logic/07.5-window.sqllogic
----

## Background

`3-serialize-project-subquery-evaluation` fixed a row-context collision in
`emitProject`. The pattern was:

```ts
sourceSlot.set(sourceRow);
const outputs = await Promise.all(callbacks.map(fn => fn(rctx)));
```

When two callbacks reference the same plan subtree (e.g. a shared CTE),
their emitted Instruction trees share plan-node attribute IDs and
collapse to the same `RowSlot` for the inner scan. Under real async
boundaries (LevelDB-backed scans), the parallel callbacks interleave
their `rowSlot.set(row)` calls and overwrite each other's entries in
`RowContextMap.attributeIndex`, causing `column()` reads to resolve
against the wrong row. Memory mode hides this because callbacks resolve
synchronously in practice.

## Audit results

The same pattern exists in three more places. All are vulnerable:

### 1. `returning.ts:29-30` — RETURNING projection callbacks

```ts
slot.set(sourceRow);
const outputs = projectionCallbacks.map(func => func(rctx));
const resolved = await Promise.all(outputs);
```

Same shape as the project.ts bug. A `RETURNING` clause with two scalar
subqueries against the same CTE (or any shared plan subtree) will race.
**Fix: sequential `for ... await` loop.**

### 2. `window.ts` `groupByPartitions` (lines 167-178) — partition keys

```ts
for (const row of rows) {
  sourceSlot.set(row);
  const partitionValues = await Promise.all(partitionCallbacks.map(cb => cb(rctx)));
  ...
}
```

Single row at a time, but multiple `PARTITION BY` callbacks evaluated in
parallel. If two partition expressions share a scalar subtree (rare but
legal — e.g. `PARTITION BY (SELECT ... FROM cte) % 2, (SELECT ... FROM cte) % 3`),
they race. **Fix: sequential inner loop.**

### 3. `window.ts` `sortRows` (lines 290-297) — ORDER BY values

```ts
const rowsWithValues = await Promise.all(rows.map(async (row) => {
  sourceSlot.set(row);
  const values = await Promise.all(orderByCallbacks.map(async (callback) => {
    return await Promise.resolve(callback(rctx));
  }));
  return { row, values };
}));
```

This site has **two** problems:

  a. The **outer** `Promise.all(rows.map(...))` sets the shared `sourceSlot`
     from many rows in parallel. If any callback yields async suspension,
     a later iteration's `sourceSlot.set(row)` will overwrite the row a
     suspended iteration is about to read. This is broken **regardless of
     shared subtrees** — it only escapes detection because typical
     orderBy expressions are synchronous column refs.

  b. The **inner** `Promise.all(orderByCallbacks.map(...))` is the same
     shared-subtree class as project.ts.

**Fix: sequential outer `for...of` loop AND sequential inner loop.**

### 4. `window.ts` `runStreaming` (lines 950-958) — streaming partition + ORDER BY

```ts
for await (const row of source) {
  promote(row);
  const partitionValues = await Promise.all(partitionCallbacks.map(cb => Promise.resolve(cb(rctx))));
  const orderByValues = await Promise.all(orderByCallbacks.map(cb => Promise.resolve(cb(rctx))));
  ...
}
```

Single row at a time (the `promote` slot is set once per source row), but
multiple callbacks share state. Same shared-subtree risk as
`groupByPartitions`. **Fix: sequential inner loops.**

## Required changes

### `packages/quereus/src/runtime/emit/returning.ts`

Replace lines 28-31 with a sequential loop mirroring `emitProject`:

```ts
const outputs: OutputValue[] = [];
for (const cb of projectionCallbacks) {
  outputs.push(await cb(rctx));
}
yield outputs as Row;
```

### `packages/quereus/src/runtime/emit/window.ts` — `groupByPartitions`

Replace the `Promise.all` (lines 169-171) with:

```ts
const partitionValues: SqlValue[] = [];
for (const cb of partitionCallbacks) {
  partitionValues.push(await cb(rctx) as SqlValue);
}
```

### `packages/quereus/src/runtime/emit/window.ts` — `sortRows`

Replace the nested `Promise.all` (lines 290-297) with sequential outer +
inner loops:

```ts
const rowsWithValues: Array<{ row: Row; values: SqlValue[] }> = [];
for (const row of rows) {
  sourceSlot.set(row);
  const values: SqlValue[] = [];
  for (const callback of orderByCallbacks) {
    values.push(await callback(rctx) as SqlValue);
  }
  rowsWithValues.push({ row, values });
}
```

Note: this also fixes the per-row sourceSlot race (issue 3a above).

### `packages/quereus/src/runtime/emit/window.ts` — `runStreaming`

Replace the two `Promise.all` calls (lines 950-958) with sequential loops:

```ts
const partitionValues: SqlValue[] = [];
for (const cb of partitionCallbacks) {
  partitionValues.push(await cb(rctx) as SqlValue);
}
...
const orderByValues: SqlValue[] = [];
for (const cb of orderByCallbacks) {
  orderByValues.push(await cb(rctx) as SqlValue);
}
```

## Performance note

These callbacks are independent in the SQL semantics sense (no
side-effects across them), so sequential evaluation is semantically
equivalent. Memory-mode workloads were already serial in practice
(callbacks resolve synchronously), so this change has near-zero impact
on memory mode. Store-mode workloads pay one extra microtask hop per
callback per row, which is dominated by the underlying scan cost.

## Tests

Mirror the canonical repro at `test/logic/49-reference-graph.sqllogic:46-54`
(two scalar subqueries against the same CTE) for each of the three
emit sites. Add cases under existing test files where they fit:

### RETURNING (add to `42.1-returning-extras.sqllogic`)

```sql
create table tr (id integer primary key, v integer);
insert into tr values (1, 10), (2, 20), (3, 30);

with high as (select * from tr where v >= 20)
insert into tr values (4, 40)
returning
  (select count(*) from high) as count,
  (select sum(v) from high) as sum;
-- expect: [{"count": 2, "sum": 50}]
```

### Window PARTITION BY (add to `07.5-window.sqllogic`)

```sql
with high as (select * from tr where v >= 20)
select
  row_number() over (
    partition by (select count(*) from high), (select sum(v) from high)
  ) as rn
from tr;
-- expect: monotonically increasing rn (single partition since both keys
-- are constants); failure mode would be wrong/null partition values
-- triggering planner errors or row miscounting.
```

### Window ORDER BY (add to `07.5-window.sqllogic`)

```sql
with high as (select * from tr where v >= 20)
select
  v,
  row_number() over (
    order by (select count(*) from high), (select sum(v) from high)
  ) as rn
from tr
order by v;
-- expect: rn = 1,2,3,4 (single peer group on constant keys, order by v)
```

All three new tests should pass under `yarn test` (memory) AND
`yarn test:store` (LevelDB) — the store path is what exposes the bug.

## TODO

- Apply the four code edits in `returning.ts` and `window.ts` per the
  specifications above.
- Add the three test cases to existing `.sqllogic` files
  (42.1-returning-extras and 07.5-window).
- Run `yarn build` from repo root.
- Run `yarn test` from repo root and confirm no regressions.
- Run `yarn test:store` from repo root and confirm the new tests pass
  (they should fail on the unfixed code and pass after the edits). Stream
  output via `2>&1 | tee /tmp/store-test.log; tail -n 80 /tmp/store-test.log`
  per AGENTS.md guidance.
- Run `yarn lint` for the quereus package.
