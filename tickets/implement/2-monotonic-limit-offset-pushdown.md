---
description: Implement OrdinalSlice plan node + emitter + optimizer rule that converts ORDER BY <monotonic> LIMIT n OFFSET k into an O(log N) ordinal seek on access paths advertising supportsOrdinalSeek
prereq: monotonic-on-characteristic, bestaccessplan-monotonic-ordering
files: packages/quereus/src/planner/nodes/plan-node-type.ts, packages/quereus/src/planner/nodes/ordinal-slice-node.ts (new), packages/quereus/src/runtime/emit/ordinal-slice.ts (new), packages/quereus/src/planner/rules/access/rule-monotonic-limit-pushdown.ts (new), packages/quereus/src/planner/optimizer.ts, packages/quereus/src/runtime/emitters.ts, packages/quereus/src/vtab/filter-info.ts, packages/quereus/src/vtab/memory/module.ts, packages/quereus/src/vtab/memory/table.ts, packages/quereus/test/optimizer/monotonic-limit-pushdown.spec.ts (new)
---

## Goal

Recognize the canonical paginate-into-the-middle shape

```sql
select … from t order by x limit n offset k
```

and, when `t`'s access path advertises `monotonicOn(x)` + `supportsOrdinalSeek`, replace `LimitOffset(over Sort(over Scan))` (or `LimitOffset(over Scan)` when the scan is already sorted) with a single `OrdinalSlice` over the access plan that seeks directly to the `k`th leaf — `O(log N + n)` instead of `O(N log N + n)` or `O(k + n)`.

The prereq ticket (`bestaccessplan-monotonic-ordering`) already wires `supportsOrdinalSeek` into `BestAccessPlanResult`, validates it in `validateAccessPlan`, and lifts it onto `IndexScanNode` / `IndexSeekNode` as `physical.accessCapabilities.ordinalSeek`. The memory module **explicitly defers** advertising it (per that ticket's complete notes — the layered store doesn't cheaply support O(log N) kth-row seek). So this ticket is the first place where `ordinalSeek` actually has a live producer + consumer.

## Architecture

### `OrdinalSliceNode` (planner/nodes/ordinal-slice-node.ts)

A new physical relational plan node. Internal to the optimizer — never produced by the parser. Sits where a `LimitOffset` over a sorted retrieve used to sit.

```ts
export class OrdinalSliceNode extends PlanNode implements UnaryRelationalNode {
  override readonly nodeType = PlanNodeType.OrdinalSlice;

  constructor(
    scope: Scope,
    /** Retrieve-shaped child whose physical leaf advertises ordinalSeek + monotonicOn(attrId) */
    public readonly source: RelationalPlanNode,
    /** Attribute we're sliced on. Must match the leaf's monotonicOn. */
    public readonly attrId: number,
    /** 0-based ordinal of the first emitted row; may be a parameter. May be undefined ⇒ 0. */
    public readonly offsetExpr: ScalarPlanNode | undefined,
    /** Number of rows to emit; may be a parameter. undefined ⇒ unbounded. */
    public readonly limitExpr: ScalarPlanNode | undefined,
    /** Direction inherited from the leaf's monotonicOn. */
    public readonly direction: 'asc' | 'desc',
  ) { … }
}
```

Type / attribute shape mirrors `source` (slicing preserves both). `computePhysical` propagates `ordering`, `uniqueKeys`, and `monotonicOn` from the child; `accessCapabilities` is **not** propagated past the slice (it's a property of the leaf, not of the slice). Estimated rows: `min(limitExpr-or-source-rows, source.estimatedRows)`.

`getChildren()` returns `[source, ...(offsetExpr ? [offsetExpr] : []), ...(limitExpr ? [limitExpr] : [])]` — same order convention `LimitOffsetNode` uses but with offset before limit (because offset is the more-essential field for this node — it's what makes the slice meaningful).

`withChildren`, `toString`, `getLogicalAttributes` follow the existing patterns from `limit-offset.ts`.

### `FilterInfo` extension (vtab/filter-info.ts)

Today `FilterInfo` is just `idxNum/idxStr/constraints/args/indexInfoOutput`. There is no runtime-time channel for limit/offset. Add two optional fields:

```ts
export interface FilterInfo {
  // … existing fields …

  /**
   * If set, the access plan honors a soft row cap — the vtab should stop
   * emitting after this many rows. Pushed down by OrdinalSlice / future
   * limit-pushdown work.
   */
  limit?: number;

  /**
   * If set, the access plan walks its monotonic index and seeks directly
   * to the kth row in monotonic order before emitting. Only honored when
   * the plan was chosen with `supportsOrdinalSeek` advertised.
   */
  offset?: number;
}
```

The fields are optional and additive. Existing modules and runtime paths ignore them. The `OrdinalSlice` emitter is the only writer.

### Emitter (runtime/emit/ordinal-slice.ts)

The emitter builds on `emitSeqScan` (`runtime/emit/scan.ts`) — it does **not** route through the existing `LimitOffset` emitter, since the whole point is to push the offset/limit into `vtab.query()` via `FilterInfo`.

Sketch:

```ts
export function emitOrdinalSlice(plan: OrdinalSliceNode, ctx: EmissionContext): Instruction {
  // The source must reduce to a physical access node we can rewrap with limit/offset.
  // Locate the IndexScan/IndexSeek leaf in the source pipeline.
  const leaf = findAccessLeaf(plan.source);

  async function* run(rctx, sourceRows: AsyncIterable<Row>, ...args) {
    // Resolve offset / limit expressions
    const offsetVal = await resolveInt(args, plan.offsetExpr, 0);
    const limitVal  = await resolveInt(args, plan.limitExpr, Infinity);
    if (limitVal <= 0) return;

    // sourceRows is an iterable from the access leaf with FilterInfo augmented
    // (see below). The leaf already honored offset+limit; we just forward.
    let emitted = 0;
    for await (const row of sourceRows) {
      yield row;
      if (++emitted >= limitVal) break;
    }
  }
  // …
}
```

Two viable wirings; pick **option A** unless it proves unworkable in tess:

* **A. Augment `FilterInfo` at emit time.** `OrdinalSlice` doesn't re-emit the leaf; instead, it wraps the leaf's emitter through a thin adapter that overrides `filterInfo.limit` / `filterInfo.offset` based on the resolved expressions. Concretely, `emitOrdinalSlice` does **not** call `emitPlanNode(plan.source)` and stitch above; it calls a new helper `emitAccessLeafWithSlice(leaf, offsetExpr, limitExpr, ctx)` that produces the leaf's instruction with offset/limit threaded through a closure variable into a per-execution `FilterInfo` clone. The runtime still calls `vtabInstance.query(filterInfo)`, but the FilterInfo it sees has `offset`/`limit` populated. This keeps FilterInfo as the single channel and works for both `IndexScan` and `IndexSeek` leaves.

* **B. Emitter consumes-and-discards above the leaf.** Wraps the existing `scan.ts` emitter and applies offset/limit in the runtime loop. This is **wrong** — it defeats the purpose of the rule (we'd still iterate `k+n` rows). Only acceptable as a temporary fallback if the vtab silently ignores `filterInfo.offset` (bad practice; we'd rather error).

Option A is correct. The implementer should refactor `emitSeqScan` so the `vtabInstance.query(...)` line takes a `FilterInfo` derivative that the caller can provide — or factor out a helper from it that `emitOrdinalSlice` calls directly with an augmented `FilterInfo`. Either approach keeps the leaf's connect/disconnect lifecycle intact.

Register the emitter in `runtime/emitters.ts` alongside the other relational emitters.

### Rule (planner/rules/access/rule-monotonic-limit-pushdown.ts)

Triggered on `LimitOffsetNode`. Fires when **all** of the following hold:

1. The child of `LimitOffset` (after stripping at most one `Sort`) is a physical access leaf whose `physical.accessCapabilities?.ordinalSeek === true`.
2. If a `Sort` is present, its sort keys reduce (via `physical-utils.extractOrderingFromSortKeys`) to a single column whose attribute id matches the leaf's `physical.monotonicOn[0].attrId`, with direction matching `physical.monotonicOn[0].direction`.
3. If no `Sort` is present, the leaf's `physical.monotonicOn` is set (no further check needed — slice walks the leaf's emit order).
4. No node sits between the `Sort` (or `LimitOffset`) and the leaf that would alter cardinality. In practice: any intervening `FilterNode` whose predicate isn't fully residual-free would invalidate the offset arithmetic; reject in that case.
5. `ORDER BY` references exactly one column. Multi-key ORDER BY is out of scope.

When all conditions hold, emit:

```
OrdinalSlice(source = leaf,
             attrId = monotonicOn[0].attrId,
             offsetExpr = limitOffset.offset,
             limitExpr = limitOffset.limit,
             direction = monotonicOn[0].direction)
```

…replacing the entire `LimitOffset[/Sort]/leaf` subtree.

**Negative cases** the rule must explicitly reject (each gets a test):

* Sort over a non-monotonic source (e.g., `Sort` over `SeqScan`). The existing `LimitOffset(Sort(SeqScan))` path remains correct.
* `ORDER BY` on an attribute other than the advertised monotonic one.
* `ORDER BY x` but leaf advertises `monotonicOn(y)` (different attribute).
* `ORDER BY x DESC` but leaf advertises `direction: 'asc'` (and no reverse-iteration capability — out of scope for this ticket; default to non-firing).
* A `Filter` (not folded into the access plan) sitting between `LimitOffset` and the leaf.
* The leaf advertises `monotonicOn` but **not** `ordinalSeek` (e.g., today's memory module — the slice would still buffer-and-discard, which is no win).
* Multi-column `ORDER BY`.

**Non-firing falls through** to the existing pipeline (LimitOffset over Sort over Scan, or LimitOffset over Scan with grow-retrieve's existing `request.limit/offset` plumbing). Both branches were already correct before this ticket and must remain correct after.

### Rule registration (optimizer.ts)

Register in the **PostOptimization** pass (or late Physical pass), priority near the join-physical-selection rules — after `select-access-path` has converted retrieves to physical leaves, so the rule can read `leaf.physical.accessCapabilities` directly. Use `nodeType: PlanNodeType.LimitOffset`, `phase: 'impl'`.

```ts
this.passManager.addRuleToPass(PassId.PostOptimization, {
  id: 'monotonic-limit-pushdown',
  nodeType: PlanNodeType.LimitOffset,
  phase: 'impl',
  fn: ruleMonotonicLimitPushdown,
  priority: 8,   // before mutating-subquery-cache (10) and after join-physical-selection (5)
});
```

### Cost

`OrdinalSlice` cost ≈ `log2(N) * seekCost + n * rowCost` with `seekCost ≈ 1.0` and `rowCost ≈ 0.3` (reuse the existing seq/index scan cost constants in `planner/cost/`). Compare against `accessPlan.cost + (k + n) * rowCost` for the existing limit-pushdown shape and `N*log(N) + n` for sort+limit. The slice should win for any `k > 0` when `ordinalSeek` is available; the existing branches already cover the no-ordinal-seek case.

### Memory-module reference implementation

To exercise the rule end-to-end, the memory module needs to actually advertise `supportsOrdinalSeek` for the cases where it can serve a kth-row seek cheaply. The prereq ticket deferred this because the layered store doesn't naturally support O(log N) ordinal seek across overlay layers.

Two acceptable approaches; **prefer option 2 for this ticket** because it keeps the plan-shape tests honest with a real producer:

1. **Test fixture vtab only.** Build a minimal in-memory module in the test file that wraps a sorted array, advertises `monotonicOn` + `supportsOrdinalSeek`, and honors `filterInfo.offset` by indexing directly into the array. Keeps memory-module behavior unchanged. Rule + emitter still get end-to-end coverage. Acceptable if option 2 proves invasive.

2. **Extend memory-module in single-layer / read-only-snapshot cases.** When the read layer is a single committed snapshot (no pending overlay), the memory module's PK-ordered B-tree can support `pickByOrdinal(k)` in `O(log N)` (BTrees expose ordinal seek natively in our impl — see `packages/quereus/src/util/btree.ts` or equivalent). In that case `findBestAccessPlan` advertises `supportsOrdinalSeek: true`, and `query()` reads `filterInfo.offset` to position the iterator. The multi-layer / pending-transaction case continues to defer (advertise `supportsOrdinalSeek: false`).

If option 2 turns out to require significant memory-module surgery (>~100 LoC), park it in a follow-up ticket and ship option 1 here.

## Tests (test/optimizer/monotonic-limit-pushdown.spec.ts)

### Plan-shape tests (positive)

For each shape, assert the `query_plan(sql)` ops list contains `'ORDINALSLICE'` and **not** `'LIMITOFFSET'` over the access leaf:

* `select * from t order by id limit 5 offset 100` over a single-column-PK memory table (assuming option 2; otherwise the fixture module).
* `select * from t order by id limit 10` (no offset → offsetExpr undefined / 0).
* `select * from t order by id offset 50` (no limit → limitExpr undefined / Infinity).
* `select * from t limit 5 offset 100` (no Sort, leaf already monotonic on id).
* Parameterized: `select * from t order by id limit ? offset ?` with `[5, 100]`. The plan node should carry `ScalarPlanNode`s for both bounds; runtime resolves at execution.

### Plan-shape tests (negative — rule must NOT fire)

For each, assert the plan keeps `'LIMITOFFSET'` (or `'SORT' + 'LIMITOFFSET'`) and does **not** contain `'ORDINALSLICE'`:

* `order by v limit 5 offset 100` where `v` is a non-PK column (no monotonicOn match).
* `order by id desc limit 5 offset 100` where leaf advertises `direction: 'asc'` (today's memory module).
* `select * from t where v = 'x' order by id limit 5 offset 100` — the `WHERE` becomes a residual filter between the leaf and the slice; rule must not fire.
* `order by id, v limit 5 offset 100` — multi-key ORDER BY.
* Over a vtab that advertises `monotonicOn` but **not** `ordinalSeek` — confirms we don't fire on the prereq's existing advertisement alone.

### SQL-logic / behavioral tests

Use the fixture (or extended memory module) and execute several `(n, k)` pairs against a 1000-row table:

* `(n=10, k=0)` → first 10 rows.
* `(n=10, k=500)` → rows 501–510.
* `(n=10, k=995)` → rows 996–1000 (tests near-end behavior — slice must not over-read).
* `(n=10, k=10000)` → empty result (k past end of table).
* `(n=0, k=0)` → empty result.
* `(n=10, k=-5)` → treated as `k=0` per existing `LimitOffset` semantics (negative offset clamped). Match `LimitOffset` behavior exactly.
* Parameterized variants of the above to exercise non-literal bound resolution at runtime.

Cross-check each result against running the same query without the rule (use `tuning.disabledRules` to disable `monotonic-limit-pushdown` and re-run). Both shapes must produce identical row sequences.

### Validation

* `yarn workspace @quereus/quereus exec tsc --noEmit`
* `yarn workspace @quereus/quereus test` (full suite — no regressions)
* `yarn workspace @quereus/quereus lint`
* Stream output via `tee` for the test command per the agent rules.

## TODO

### Phase 1 — Plan node + emitter scaffold

- Add `OrdinalSlice = 'OrdinalSlice'` to `PlanNodeType` (between `LimitOffset` and `Join` in the logical block, or in the physical block — pick wherever sibling slice-shaped nodes live).
- Implement `OrdinalSliceNode` in `planner/nodes/ordinal-slice-node.ts`. Mirror `LimitOffsetNode` for `withChildren` / `getChildren` / `getLogicalAttributes`, but order children as `[source, offset?, limit?]` (offset first — it's the seek key).
- Add optional `limit?: number; offset?: number` to `FilterInfo`.
- Refactor `emitSeqScan` so the `FilterInfo` it hands to `vtabInstance.query()` can be augmented by a caller. Either (a) export a helper that takes an extra `FilterInfo` override, or (b) split out `runScan(plan, ctx, filterInfoOverride)` from the closure. Don't break existing callers.
- Implement `emitOrdinalSlice` in `runtime/emit/ordinal-slice.ts`. Resolve offset/limit expressions, build the augmented `FilterInfo`, delegate to the leaf's run helper. Include the leaf's connect/disconnect lifecycle.
- Wire the emitter in `runtime/emitters.ts`.

### Phase 2 — Rule

- Implement `ruleMonotonicLimitPushdown` in `planner/rules/access/rule-monotonic-limit-pushdown.ts`. Use `physical-utils.extractOrderingFromSortKeys` for sort-key reduction.
- Strip at most one intermediate `SortNode` (matching the requested ordering). Reject when an intermediate `FilterNode` is present.
- Locate the access leaf via a small helper (descend through `FilterNode`/`SortNode` only — anything else aborts). Read `leaf.physical.accessCapabilities?.ordinalSeek` and `leaf.physical.monotonicOn`.
- Construct `OrdinalSliceNode` and return it. Cost = the leaf's cost + `log2(rows) + emitted_rows*0.3`.
- Register in `optimizer.ts` as documented above.
- Add rule-id `'monotonic-limit-pushdown'` to the disable-list mechanism (already supported via `tuning.disabledRules`).

### Phase 3 — Producer

- Decide between fixture vtab (option 1) and memory-module extension (option 2). Default: try option 2; fall back to option 1 if it grows.
- For option 2: in `MemoryTableModule.findBestAccessPlan` / `buildMonotonicAdvertisement`, advertise `supportsOrdinalSeek: true` for the single-layer / committed-only PK-scan case. In `MemoryTable.query()`, when `filterInfo.offset` is set, position the iterator using the underlying B-tree's ordinal seek (e.g., `tree.pickByOrdinal(offset)`).
- For option 1: write the fixture in the spec file; register it in a per-test database via `db.registerVtabModule(...)`.

### Phase 4 — Tests

- Create `test/optimizer/monotonic-limit-pushdown.spec.ts` covering the positive, negative, and behavioral cases enumerated above.
- If using option 2, also extend `bestaccessplan-monotonic-advertisement.spec.ts` with one test asserting `accessCapabilities.ordinalSeek` is present on the eligible plan shape — keeps the prereq's contract tests honest.
- Run the full quereus test suite and lint.

### Phase 5 — Docs

- Update `docs/optimizer.md` (Monotonic optimizations section if present, or new subsection): document the rule, its preconditions, and the negative cases.
- Update `docs/runtime.md` `FilterInfo` reference to mention the new optional `limit`/`offset` fields and the `supportsOrdinalSeek` precondition.
- If memory-module behavior changed (option 2), note it in `docs/module-authoring.md`.
