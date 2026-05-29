description: Accept multi-source (inner-join) bodies for `on-commit-incremental` materialized views by synthesizing a per-source maintenance binding in `MaterializedViewManager.compile()`. A change to any participating source recomputes the affected slice; a source whose PK does not cleanly cover the backing physical PK falls back to a full rebuild (the existing always-correct escape). Outer/semi/anti joins and aggregate-over-join are rejected at create and deferred.
prereq: materialized-view-incremental-refresh
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/planner/analysis/key-filter.ts, packages/quereus/src/runtime/delta-executor.ts, packages/quereus/src/planner/nodes/join-node.ts, packages/quereus/src/planner/nodes/plan-node-type.ts, packages/quereus/test/logic/52-materialized-views-incremental.sqllogic, docs/materialized-views.md
----

## Summary

`MaterializedViewManager.compile()`
(`packages/quereus/src/core/database-materialized-views.ts`) currently rejects
any `on-commit-incremental` body that reads more than one base table:

```ts
const tableRefByRelKey = collectTableRefs(analyzed);
if (tableRefByRelKey.size !== 1) {
  // throw UNSUPPORTED: "'on-commit-incremental' refresh supports single-source bodies in v1"
}
```

This ticket removes that restriction for **inner-join, row-preserving** bodies
and synthesizes a `'row'` binding **per source** (each on that source's primary
key). A mutation to *any* participating source then maintains the MV at COMMIT.

## The key insight — most machinery is already multi-source

The maintenance pipeline below `compile()` is **already per-relation** and needs
no change:

- `bindings.perRelation` is a `Map<relationKey, BindingMode>`; the residual loop,
  capture-spec loop, `baseTablesInPlan`/`pkIndicesByBase` derivation, and
  `computeDeleteKeyOrder` all iterate it.
- `DeltaExecutor.runOne` (`runtime/delta-executor.ts`) already dispatches changed
  tuples per relationKey across multiple bindings in one subscription.
- `buildSubscription`'s `apply` already loops `input.perRelationTuples`, and on
  the first relation whose `residual.deleteKeyOrder === null` it does
  `rebuildBacking` + `return` — the always-correct escape.
- `injectKeyFilter` already targets a single `TableReferenceNode` by relation key.
- `mv.sourceTables` (set in `runtime/emit/materialized-view-helpers.ts`
  `collectSourceTables`) and `buildSourceUnionScope` already enumerate *all* base
  tables, so `dependencies` and the change-scope projection are already correct
  for joins.

**The only gap is `compile()`'s synthesis of the per-source bindings.**

### Why per-source delete-then-recompute is sound (the correctness net)

`computeDeleteKeyOrder(analyzed, tableRef, producing, bindCols, physicalPkOutCols)`
returns `null` for a source unless that source's binding columns (its PK), via
attribute provenance, **cover the entire backing physical PK**. That condition is
exactly *"this source contributes ≤1 MV row per source row"* (no fan-out):

- If source `S`'s PK covers the full physical PK, each `S` row maps to a single,
  point-addressable MV row. Deleting that MV PK (built from the changed `S`-PK
  tuple) and re-running the residual (the whole join body with `S` filtered to
  that key) recomputes exactly that row — correct for INSERT/UPDATE/DELETE, and
  correct when the row should *vanish* (inner-join partner gone ⇒ residual yields
  zero rows ⇒ the delete stands).
- If `S` fans out (its PK does **not** determine the physical PK — the other side
  multiplies it), `computeDeleteKeyOrder` returns `null` and that source's delta
  routes to a full rebuild. Always correct, just not incremental.

So for the canonical parent/child flatten
(`select o.id, c.name, o.total from orders o join customers c on o.cust_id = c.id`,
backing PK = `o.id`): an **orders** change maintains incrementally
(orders.id ↦ physical PK o.id, clean); a **customers** change falls to full
rebuild (physical PK o.id resolves to orders, not customers ⇒ `deleteKeyOrder`
is `null`). Both outcomes converge the MV to the correct state.

This means **no `apply`/executor/key-filter changes are required** — only the
binding synthesis, plus the eligibility gates below.

## Scope (first cut) — inner joins, row-preserving only

Accept multi-source bodies that are **inner/cross joins of base tables** with no
row-collapsing operator. Reject (UNSUPPORTED, "use `manual` refresh", pointing at
the follow-up backlog ticket) and defer:

- **Outer / semi / anti joins** (`left`/`right`/`full`/`semi`/`anti`) — the
  null-extended / filtered rows complicate the recompute slice on the non-clean
  side. → `materialized-view-incremental-outer-joins`.
- **Aggregate over a join** (`findAggregate` returns a node *and* >1 source). →
  `materialized-view-incremental-aggregate-join`.
- **Set-operation bodies** (`SetOperationNode` present). `union all` passes the
  build-time `rejectUnsupportedIncrementalBody`
  (`planner/building/materialized-view.ts`) and today only fails because of the
  `size !== 1` throw — so `compile()` must keep rejecting it explicitly once that
  throw is relaxed. → existing `materialized-view-incremental-set-ops`.
- **`DISTINCT` over >1 source** (`DistinctNode` present) — a per-binding delete
  can remove rows other source rows also contribute. Defer; rebuild-always is the
  manual escape. (Leave single-source behavior untouched.)

Keep every existing single-source behavior **byte-for-byte** — the generalized
row loop must reduce to today's path when `size === 1`.

## Design — changes to `compile()`

Restructure so the row-preserving binding derivation is a loop over *all* table
refs (single-source becomes the N=1 case):

```
analyzed = optimizeForAnalysis(plan)
tableRefByRelKey = collectTableRefs(analyzed)
if (tableRefByRelKey.size === 0) throw UNSUPPORTED("body reads no source table")

agg = findAggregate(analyzed)
if (agg) {
    // existing single-source aggregate path, but now GUARD it:
    if (tableRefByRelKey.size > 1) throw UNSUPPORTED(aggregate-over-join, defer)
    ...existing group/whole-table-aggregate logic unchanged...
} else {
    // row-preserving path — 1..N sources
    if (containsNodeType(analyzed, SetOperation)) throw UNSUPPORTED(set-op, defer)
    if (tableRefByRelKey.size > 1 && containsNodeType(analyzed, Distinct))
        throw UNSUPPORTED(distinct-over-join, defer)
    if (tableRefByRelKey.size > 1 && hasNonInnerJoin(analyzed))
        throw UNSUPPORTED(outer/semi/anti join, defer)

    for (const [relKey, ref] of tableRefByRelKey) {
        const base = `${ref.tableSchema.schemaName}.${ref.tableSchema.name}`.toLowerCase();
        const pkCols = ref.tableSchema.primaryKeyDefinition.map(d => d.index);
        if (pkCols.length === 0)
            throw UNSUPPORTED(`source '${base}' has no primary key`);  // mirror single-source rule
        perRelation.set(relKey, { kind: 'row', keyColumns: pkCols });
        relationToBase.set(relKey, base);
    }
}
```

Everything after `const bindings = { perRelation, relationToBase }` — the
`baseTablesInPlan`/`pkIndicesByBase` build, the `recordExtras` capture loop, the
per-relation residual + `computeDeleteKeyOrder` loop, the return — **stays as is**
and now naturally handles N relations.

### `hasNonInnerJoin` / `containsNodeType` helpers

`optimizeForAnalysis` is the lighter *analysis* pass; confirm during
implementation what it emits for a join body (most likely the logical `JoinNode`
with `.joinType`, but it *may* surface physical aggregates today via
`findAggregate`'s `StreamAggregate`/`HashAggregate` set, so do not assume).

- Join-type gate: walk the analyzed plan; for every join-bearing node, require
  `joinType ∈ {'inner','cross'}`. `JoinType` is
  `'inner'|'left'|'right'|'full'|'cross'|'semi'|'anti'`
  (`planner/nodes/join-node.ts`). Logical joins are `JoinNode` (PlanNodeType
  `Join`, exposes `joinType` / `getJoinType()`). If physical join nodes
  (`NestedLoopJoin`/`HashJoin`/`MergeJoin`) or `FanOutLookupJoin`/`AsofScan`
  appear in the analyzed plan, treat any whose join type is not inner/cross — or
  whose type you cannot read — as a reject (conservative; defer). Prefer a
  duck-typed read of a `joinType` property so it works across logical/physical
  variants, mirroring how `findAggregate` spans both.
- `containsNodeType(node, PlanNodeType.SetOperation|Distinct)`: simple recursive
  `getChildren()` walk returning true on first match (same shape as the existing
  `findAggregate`).

### Diagnostics

Reuse the existing message style (name the MV, name the offending shape, end with
"use `manual` refresh", reference the tracking ticket where one exists). The
relaxed multi-source path means the old "supports single-source bodies in v1"
message is **removed**; the no-source and per-source-no-PK messages replace its
defensive coverage.

## Edge cases to keep in mind (covered by the design, worth a test or a note)

- **Both sources change in one commit.** `apply` iterates `perRelationTuples`; a
  non-clean source (customers) triggers `rebuildBacking` + `return` which also
  fixes the clean source — correct regardless of map iteration order.
- **Both sources clean (1:1 join on equal keys, e.g. `on o.id = c.id`).** Each
  does an independent point delete-then-recompute; the residual recomputes the
  full row each time, so the result is correct (idempotent). Add a test.
- **Self-join (`from t a join t b ...`).** Two relationKeys, same base; the
  executor dispatches a `t` change to both bindings. Each is gated independently
  by `computeDeleteKeyOrder`; typically both non-clean ⇒ rebuild. Correct. Note
  as a known (rebuild-heavy) shape; a test is optional.
- **Inferred backing PK may be all-columns.** If `keysOf` over the join output
  cannot prove `orders.id` is a key (FD not emitted), the backing physical PK is
  all-columns and *every* source becomes non-clean ⇒ every change rebuilds. Still
  correct (the sqllogic assertions are correctness-only and pass either way); it
  just won't exercise the incremental branch. During implementation, sanity-check
  that the canonical orders/customers case actually infers PK = `{o.id}` so the
  incremental path is genuinely exercised — if not, the test still passes but note
  it.

## Docs

Update `docs/materialized-views.md`:

- § Incremental refresh → Eligibility: add "multi-source **inner-join**
  row-preserving bodies" to the accepted shapes; move "multiple sources / joins"
  out of the rejected list and replace with "outer/semi/anti joins" and
  "aggregate over a join" (with the new backlog slugs).
- § Apply contract / Cost fallback: note that for a join, each source is gated
  independently — the source(s) whose PK covers the physical PK maintain
  incrementally; the rest fall to full rebuild (no whole-MV rejection).
- § Out of scope / roadmap → Incremental refresh "Remaining work": drop
  "multi-source / join bodies" (now delivered for inner joins); add the two new
  backlog slugs for outer joins and aggregate-over-join.

## Tests

Add a new section (≈ #19+) to
`packages/quereus/test/logic/52-materialized-views-incremental.sqllogic`. Follow
the file's `→ [json]` / `-- error: <substring>` conventions. Key scenarios and
expected outputs:

- **Parent/child inner join — clean child side, rebuild parent side.**
  `customers(id pk, name)`, `orders(id pk, cust_id, total)`; MV
  `select o.id as oid, c.name as cname, o.total as total from orders o join customers c on o.cust_id = c.id`
  incremental. Verify create-time contents, then:
    - orders UPDATE (`set total=999 where id=10`) reflected;
    - orders INSERT (new matching order) appears;
    - orders DELETE removes its MV row;
    - orders moved to a non-existent customer (`set cust_id=99`) ⇒ inner join drops
      that MV row (residual yields zero, delete stands);
    - customers UPDATE (rename) ⇒ rebuild path, all that customer's MV rows show
      the new name;
    - customers DELETE ⇒ rebuild path, the matching orders' MV rows vanish.
- **Both-clean 1:1 join** (`on a.id = b.id`, backing PK shared): an update on
  either side reflects correctly.
- **Manual `refresh materialized view` on a join MV** still resyncs (escape valve).
- **Eligibility rejections (all `-- error:`):**
    - `left join` body → rejected (substring e.g. `on-commit-incremental` or a
      join-specific word you put in the diagnostic);
    - `... group by c.id` over a join → rejected (aggregate-over-join);
    - `select id from orders union all select id from customers` incremental →
      still rejected (set-operation);
    - a join source lacking a primary key → rejected (no primary key).
- Drop all created MVs/tables at the end of the section (the file is one script;
  match the existing cleanup pattern).

Run: `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/mvjoin.log; tail -n 60 /tmp/mvjoin.log`
(stream, don't silently redirect). Also run lint
(`yarn workspace @quereus/quereus run lint`, single-quote globs on Windows) and a
type-check via the build for the quereus package.

## TODO

- [ ] Confirm what `optimizeForAnalysis` emits for an inner-join body (logical
      `JoinNode` vs physical join node) — pick the join-type detection surface
      accordingly (prefer duck-typed `joinType`).
- [ ] Add `containsNodeType(node, type)` and `hasNonInnerJoin(node)` helpers next
      to `findAggregate` in `database-materialized-views.ts`.
- [ ] Restructure `compile()`: relax the `size !== 1` throw; add the
      no-source, aggregate-over-join, set-op, distinct-over-join, non-inner-join,
      and per-source-no-PK gates; generalize the row-binding derivation to loop
      over all table refs.
- [ ] Verify the post-`bindings` machinery (capture specs, residuals,
      `computeDeleteKeyOrder`, subscription) works unchanged for N relations.
- [ ] Add the sqllogic section above; ensure correctness for orders/customers
      INSERT/UPDATE/DELETE on both sides + the rejection cases.
- [ ] Sanity-check the canonical join infers backing PK `{o.id}` so the
      incremental (non-rebuild) branch is exercised; note if it doesn't.
- [ ] Update `docs/materialized-views.md` (eligibility, apply contract, roadmap).
- [ ] `yarn workspace @quereus/quereus test` + lint green; no regression in the
      existing 18 incremental scenarios.
