description: Serialize projection evaluation in emitProject to prevent row-context collision between scalar subqueries sharing plan subtrees
dependencies: none
files:
  packages/quereus/src/runtime/emit/project.ts
  packages/quereus/test/logic/49-reference-graph.sqllogic
----

## What changed

`emitProject` used `Promise.all(projectionFunctions.map(fn => fn(rctx)))` to
evaluate projection callbacks concurrently. When two scalar subqueries in the
same SELECT list referenced the same CTE, their emitted `Instruction` trees
shared plan-node attribute IDs. Under real async boundaries (LevelDB store
iteration), interleaved `rowSlot.set(row)` calls overwrote each other's
entries in `RowContextMap.attributeIndex`, causing `column()` reads to
resolve against the wrong row.

Replaced the parallel evaluation with a sequential `for … await`:

```ts
const outputs: OutputValue[] = [];
for (const fn of projectionFunctions) {
  outputs.push(await fn(rctx));
}
```

This is semantically equivalent — SQL projection expressions are
independent — and matches the serial behavior that memory-mode tests always
exhibited.

## Validation / use cases

- `test/logic/49-reference-graph.sqllogic:54` — the canonical repro:
  two scalar subqueries referencing the same CTE. Previously failed in store
  mode with `count = 0` instead of `2`; now returns correct `count = 2,
  sum = 50`.
- General multi-projection queries with scalar subqueries that share plan
  subtrees (not just CTEs — any case where multiple projections independently
  iterate the same underlying source).
- Memory-mode behavior unchanged (already serial in practice).

## Test results

- `yarn test` — passes (all memory tests green).
- `yarn test:store` — 49-reference-graph now passes. One remaining failure
  in 50-declarative-schema.sqllogic ("Deferred constraint execution found
  multiple candidate connections for table test2.a") is pre-existing and
  unrelated to projection — it concerns deferred constraints and connection
  management.

## Review focus

- Confirm the sequential loop is the correct fix — no alternative (e.g.
  per-branch RowContextMap cloning) is being sacrificed for scope reasons.
- Confirm no plan/optimizer tests relied on projection parallelism timing.
- The follow-up perf concern noted in the original ticket (CTE
  double-scanning via separate `CacheNode`s per `CTEReference`) is explicitly
  out of scope and should be tracked separately if desired.
