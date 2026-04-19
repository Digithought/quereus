description: Project emits projections with Promise.all, causing row-context collision when multiple scalar subqueries share plan subtrees and iterate concurrently under real async boundaries (store mode)
dependencies: none
files:
  packages/quereus/src/runtime/emit/project.ts
  packages/quereus/src/runtime/context-helpers.ts
  packages/quereus/src/runtime/scheduler.ts
  packages/quereus/test/logic/49-reference-graph.sqllogic
----

## Root cause

`49-reference-graph.sqllogic:54` fails in store mode only:

```sql
WITH high_values AS (SELECT * FROM t1 WHERE value >= 20)
SELECT
  (SELECT COUNT(*) FROM high_values) AS count,  -- store: 0, memory: 2
  (SELECT SUM(value) FROM high_values) AS sum;  -- 50 in both
```

The execution trace (`--show-trace --store`) makes the bug explicit. Both scalar
subqueries iterate `validated(SeqScan(t1))` at the same time, and after the
first couple of rows the `column(value)` reads start returning values that
belong to the *other* iterator's row:

```
[0] ROW #1 (SeqScan(t1)): [2,20]
[0] OUTPUT (column(value)): 10     <- should be 20
```

### Why

1. `emitProject` (`packages/quereus/src/runtime/emit/project.ts:32`) evaluates
   all projection callbacks in parallel:
   ```ts
   const outputs = await Promise.all(projectionFunctions.map(fn => fn(rctx)));
   ```
2. Each scalar-subquery callback is its own `Scheduler` program (`emitCall`),
   but they share the same `RuntimeContext` (same `rctx`).
3. Both subqueries reference the same CTE, so the materialization advisory's
   transform produces a plan graph where `CTEReference#314`, `CTE#313`,
   `Filter#312`, `SeqScan#311`, and the `ColumnReference`s are the same
   `PlanNode` instances used in both branches. Each emission creates fresh
   `Instruction` objects, but the `RowDescriptor`s they build carry the
   **same attribute IDs** (attributes are cached on the plan node).
4. `RowContextMap.attributeIndex` (`context-helpers.ts:40`) is keyed by
   attribute ID. When branch A's `SeqScan` rowSlot `.set(rowA)` is followed by
   branch B's `.set(rowB)` (interleaved because LevelDB iteration has real
   `await` boundaries), branch B's entry overwrites branch A's in
   `attributeIndex[attrId]`. Branch A's `column(value)` then resolves through
   B's `rowGetter` and returns the wrong value.
5. Memory mode hides the bug because the memory vtab's async iteration returns
   rows synchronously enough that Program A drains before Program B starts
   its first `await`.

### Fix

Change `emitProject` to evaluate projection callbacks **sequentially**:

```ts
const outputs: SqlValue[] = [];
for (const fn of projectionFunctions) {
  outputs.push(await fn(rctx));
}
```

This is semantically equivalent (SQL projection expressions are independent),
eliminates the concurrent-iteration race on the shared `RowContextMap`, and
restores correct results without touching the store, the cache, or the
advisory. Memory mode already behaved as if it were serial; this just makes
the contract explicit.

### Out of scope (follow-up perf ticket if desired)

The same query still iterates the underlying `t1` scan twice — once per
scalar subquery. The materialization advisory wraps each `CTEReference` in
its own `CacheNode` (separate state per reference) instead of materializing
once at the `CTE` level. Correctness is restored by this fix; single-pass
CTE materialization for multi-reference CTEs is a separate optimization
concern (see `rule-cte-optimization.ts` — only triggers when `sourceSize > 0`,
which is false when store stats haven't been persisted yet).

### TODO

- Edit `packages/quereus/src/runtime/emit/project.ts` to replace the
  `Promise.all(projectionFunctions.map(...))` call with a sequential
  `for … await` over the projection functions.
- Run `yarn test` (memory) and confirm no regressions — especially any
  tests with multi-projection queries and parallel scalar subqueries.
- Run `yarn test:store` and confirm `49-reference-graph.sqllogic` now
  passes in store mode.
- If any plan/optimizer tests relied on projection parallelism timing, update
  or relax them.
