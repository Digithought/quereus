---
description: Extend BestAccessPlanResult with fields letting a vtab advertise monotonic ordering on a column plus capability flags for ordinal seek and streaming asof; lift those advertisements onto the retrieve node's physical properties
prereq: monotonic-on-characteristic
files: packages/quereus/src/vtab/best-access-plan.ts, packages/quereus/src/vtab/module.ts, packages/quereus/src/planner/nodes/retrieve-node.ts, packages/quereus/src/planner/rules/access/rule-select-access-path.ts, packages/quereus/src/vtab/memory/module.ts, packages/quereus/test/optimizer/

---

## Architecture

`BestAccessPlanResult` is the vtab module's contract for describing what an access path delivers: cost, row estimate, ordering, handled filters, uniqueness, indexability. The current shape lets a vtab advertise *positional* ordering (`providesOrdering`), which is consumed by ordering-elimination and `ORDER BY` rewrite rules.

What it does not currently express is whether an access path is **strictly monotonic** on a column — i.e., the underlying storage produces rows in a known total order such that the optimizer can rely on it for stronger rewrites than ordering alone licenses (ordinal-seek pushdown, streaming asof, monotonic merge join, monotonic window fast paths). This ticket adds three additive fields to `BestAccessPlanResult` and the retrieve-node plumbing that lifts those advertisements into `physical.monotonicOn` (added by the prereq `1-monotonic-on-characteristic`) plus a small `accessCapabilities` record so downstream rules can check ordinal-seek / asof-right support.

It does **not** introduce optimizer rules — those land in companion tickets that consume the advertisement.

### Extended `BestAccessPlanResult`

```ts
// packages/quereus/src/vtab/best-access-plan.ts

export interface BestAccessPlanResult {
  // … existing fields …

  /**
   * The access path emits rows in monotonic non-decreasing order on
   * the named column. Stronger than `providesOrdering` because:
   *   - it is a property of the underlying storage (not just a sort),
   *   - the column's values are total-ordered with no gaps in coverage,
   *   - downstream rules may rely on `between(a,b)` semantics.
   *
   * `strict = true` additionally guarantees no two rows share a value.
   */
  monotonicOn?: {
    columnIndex: number;
    direction: 'asc' | 'desc';
    strict: boolean;
  };

  /**
   * The access path supports O(log N) seek to the kth row in monotonic
   * order — i.e., LIMIT n OFFSET k can be pushed into the scan instead
   * of buffer-and-discard. Implies `monotonicOn` is set.
   *
   * The vtab's query()/scan() implementation must accept an offset
   * directive in its access-plan request when this is advertised.
   */
  supportsOrdinalSeek?: boolean;

  /**
   * The access path can serve as the right input to a streaming asof
   * scan: given a left row and its match key, the vtab can position
   * its cursor at the largest row ≤ that key in O(log avg-gap), and
   * advance forward without re-seeking for monotonically increasing
   * left keys. Implies `monotonicOn` is set.
   */
  supportsAsofRight?: boolean;
}
```

All three fields are optional; existing modules that don't set them are unaffected.

### Companion request fields

The existing `BestAccessPlanRequest.offset` field is reused for the ordinal-seek case (no shape change). The doc comment is extended to clarify that when a module advertises `supportsOrdinalSeek`, it consumes `offset` directly rather than using the `limit + offset` total-emit pattern. No new request shape is introduced.

For `supportsAsofRight`, the *runtime* contract on the vtab's iterator is what matters — the asof emitter (separate ticket) drives the right vtab through its existing scan interface, just with a specific access-plan choice and a forward-only iteration discipline. No new method on `VirtualTableModule`; the advertised capability is what licenses the emitter to use the vtab in that role.

### Retrieve-node lifting

`RetrieveNode` (`packages/quereus/src/planner/nodes/retrieve-node.ts`) is the boundary between the vtab access plan and the rest of the optimizer. Today the access plan is computed inside `rule-select-access-path.ts` and consumed to build a physical leaf — the `BestAccessPlanResult` itself is not durably attached to the retrieve node. Two options for the lift point:

1. Lift onto `RetrieveNode` itself by stashing a small `accessCapabilities?` field that downstream rules read via `node.physical.monotonicOn` (lifted from the result during physical-property derivation, i.e., in `RetrieveNode.computePhysical`). This requires the access plan to be available at physical-property derivation time.

2. Lift onto the *physical leaf* (`SeqScanNode` / `IndexScanNode` / `IndexSeekNode`) at the moment `selectPhysicalNode` builds it, by passing `monotonicOn` / capability flags into those nodes' physical-property computation.

Option 2 is the natural fit for current code structure: the access plan is in scope inside `rule-select-access-path.ts` and the physical leaf nodes are where `physical.ordering` is currently set. The `RetrieveNode` itself will then see the lifted `physical.monotonicOn` propagate up through ordinary children-physical inheritance.

Implementation choice: **Option 2** — extend the physical leaf nodes (`IndexScanNode`, `IndexSeekNode`; `SeqScanNode` does not advertise monotonic ordering) to accept and surface `monotonicOn` and the capability flags via their `computePhysical()` overrides. The retrieve-node-side change is then minimal: it propagates physical properties from its child as today.

The `accessCapabilities` slot is a small additional `PhysicalProperties` field — capability flags that aren't true relational characteristics but need to flow alongside `monotonicOn` so downstream rules can consult them without re-running `getBestAccessPlan`. Add this as `accessCapabilities?: { ordinalSeek?: boolean; asofRight?: boolean }` on `PhysicalProperties` (or stash on the `IndexScanNode`/`IndexSeekNode` itself; consult prereq's `monotonicOn` shape for symmetry).

### Translating `columnIndex` → `attrId`

The vtab advertises `columnIndex` (positional, table-relative). The optimizer-side `MonotonicOnInfo` (per prereq `1-monotonic-on-characteristic`) is keyed by `attrId`. Translation lives in the physical-leaf node:

```
const attrs = tableRef.getAttributes();
const attrId = attrs[accessPlan.monotonicOn.columnIndex].id;
```

`tableRef.getAttributes()` is already in scope wherever `IndexScanNode` / `IndexSeekNode` are constructed.

### Module-author guidance

A module advertises monotonic ordering when its access path is backed by a sorted index over the column with no value duplicates within the path's emit order, and the column type's comparator agrees with the index's storage comparator. Examples:

- A B+tree index on `created_at` whose values are unique within the table → `monotonicOn: { columnIndex: <created_at>, direction: 'asc', strict: true }`.
- A sequence column backed by a counted B+tree → same shape.
- A heap with a sorted secondary index that allows duplicate keys → `strict: false`; downstream rules either treat the column as a non-strict candidate or skip the rewrite.

A module advertises `supportsOrdinalSeek` when its index supports O(log N) seek to the kth entry without scanning. (B+trees with subtree counts; counted variants; some columnar formats.) Plain sorted indexes that require leaf-walking from the start to find offset k must not advertise it; the optimizer will still pick the path for non-pushdown LIMIT, but won't push.

A module advertises `supportsAsofRight` when its scan iterator supports forward-only progression after an initial seek without re-seeking per left-row. This is true for any sorted-index walk; advertising it is essentially "I'm sorted on this column, you can drive me as the right side of an asof."

### Memory-table reference implementation

`MemoryTableModule.findBestAccessPlan` (`packages/quereus/src/vtab/memory/module.ts`) decides between full-scan / equality / range / ordering paths today. Wire it to advertise:

- `monotonicOn` whenever the chosen path is index-style and the index's first key column is unique within the path (PK-style index over a single-column unique key, or any index where the path emits distinct values for the leading column). Default `direction: 'asc'` unless the index is descending.
- `supportsAsofRight` whenever `monotonicOn` is set (memory-table cursor advances forward without re-seek).
- `supportsOrdinalSeek` is **deferred** — the memory-table's layered-store scan cannot cheaply seek to offset k. Add a TODO comment in the module identifying this, but do not advertise the flag.

Add a fixture / test scenario with at least one memory table whose access plan triggers the advertisement, so downstream optimizer-rule tickets have a non-Lamina vtab to validate against.

### Diagnostics

`query_plan()` already serializes `node.physical` via `safeJsonStringify` (see `packages/quereus/src/func/builtins/explain.ts`). Once `monotonicOn` and `accessCapabilities` are in `PhysicalProperties`, they appear automatically in the EXPLAIN output. No additional emit work needed; just verify in tests.

### Backwards compatibility

Adding the three optional fields to `BestAccessPlanResult` is purely additive. Existing modules that don't set them remain unchanged; downstream rules that don't read them are unaffected.

## TODO

### Phase 1: Interface

- Add the three optional fields (`monotonicOn`, `supportsOrdinalSeek`, `supportsAsofRight`) to `BestAccessPlanResult` in `packages/quereus/src/vtab/best-access-plan.ts` with the contracts and JSDoc described above.
- Extend `validateAccessPlan` to check that `monotonicOn.columnIndex` is in range; that `supportsOrdinalSeek` and `supportsAsofRight` only appear when `monotonicOn` is set.
- Extend the JSDoc on `BestAccessPlanRequest.offset` to clarify the ordinal-seek interaction (modules that advertise `supportsOrdinalSeek` consume `offset` directly).

### Phase 2: Retrieve-node / physical-leaf lifting

- In `IndexScanNode` and `IndexSeekNode` (`packages/quereus/src/planner/nodes/table-access-nodes.ts`), accept the `monotonicOn` advertisement (translate `columnIndex` → `attrId` using the table reference's attributes) and surface it via `computePhysical()` as `physical.monotonicOn` (the field added by `1-monotonic-on-characteristic`).
- Add `accessCapabilities?: { ordinalSeek?: boolean; asofRight?: boolean }` to `PhysicalProperties` and surface it from the same physical-leaf nodes when advertised.
- In `rule-select-access-path.ts` (`selectPhysicalNodeFromPlan` and `selectPhysicalNodeLegacy`), pass `accessPlan.monotonicOn` / `supportsOrdinalSeek` / `supportsAsofRight` into the constructed `IndexScanNode` / `IndexSeekNode`.
- Verify `RetrieveNode` propagates `physical.monotonicOn` from its child unchanged (default child-inheritance path is sufficient; no override required unless a propagation test reveals otherwise).

### Phase 3: Memory-table reference implementation

- In `packages/quereus/src/vtab/memory/module.ts` (`findBestAccessPlan` and helper builders), advertise `monotonicOn` and `supportsAsofRight` when the chosen path is index-style on a unique leading column.
- Leave a TODO comment near the cost calculation noting that `supportsOrdinalSeek` is deferred for memory-table (the layered-store scan does not cheaply support k-th-row seek).

### Phase 4: Tests

- Unit tests for `validateAccessPlan` rejecting bad shapes (`supportsOrdinalSeek` without `monotonicOn`, out-of-range `columnIndex`).
- Plan-shape tests under `packages/quereus/test/optimizer/` confirming `physical.monotonicOn` appears on the retrieve node (and lifted physical leaf) when the memory-table path advertises it. Use a unique-PK memory table.
- Negative tests confirming non-strict / non-monotonic paths leave `physical.monotonicOn` unset (e.g., a memory-table full scan without an index, or a path on a non-unique key).
- Verify `query_plan()` JSON includes `monotonicOn` and `accessCapabilities` on relevant nodes (a single end-to-end test using the existing EXPLAIN test pattern).

### Validation

- `yarn build` then `yarn test 2>&1 | tee /tmp/test.log` — ensure no regressions.
- `yarn lint` (quereus only) for style.
