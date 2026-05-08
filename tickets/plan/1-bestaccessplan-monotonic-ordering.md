---
description: Extend BestAccessPlanResult with fields letting a vtab advertise monotonic ordering on a column plus capability flags for ordinal seek and streaming asof
files: packages/quereus/src/vtab/best-access-plan.ts, packages/quereus/src/vtab/module.ts, packages/quereus/src/planner/nodes/retrieve-node.ts, packages/quereus/src/planner/rules/access/

---

## Architecture

`BestAccessPlanResult` is the vtab module's contract for describing what an access path delivers: cost, row estimate, ordering, handled filters, uniqueness, indexability. The current shape lets a vtab advertise *positional* ordering (`providesOrdering`), which is consumed by ordering-elimination and `ORDER BY` rewrite rules.

What it does not currently express is whether an access path is **strictly monotonic** on a column — i.e., the underlying storage produces rows in a known total order such that the optimizer can rely on it for stronger rewrites than ordering alone licenses. Several worthwhile rewrites — ordinal-seek pushdown, streaming asof, monotonic merge join — depend on this stronger guarantee. They cannot be unlocked by inspecting `providesOrdering` alone, because ordering is consumed for set-comparison and equality-elimination contexts where strictness/totality aren't required.

This ticket extends `BestAccessPlanResult` with three additive fields letting a vtab advertise the property and the capabilities that ride on it. It does not introduce optimizer rules — those land in companion tickets that consume the advertisement.

### Extended interface

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

All three fields are optional; existing modules that don't set them are unaffected. The new fields are checked by downstream optimizer rules (separate tickets) and surfaced in `query_plan()` JSON for diagnostics.

### Companion request fields

When `supportsOrdinalSeek` is advertised and the optimizer chooses to push `LIMIT/OFFSET` into the scan, it communicates the desired offset through the existing `BestAccessPlanRequest.offset` field. (That field already exists for limit-pushdown, with the documented requirement that the scan emit `limit + offset` rows; ordinal-seek pushdown is the case where the scan can satisfy `offset` directly.) No request shape changes.

For `supportsAsofRight`, the *runtime* contract on the vtab's iterator is what matters — the asof emitter (separate ticket) drives the right vtab through its existing scan interface, just with a specific access-plan choice and a forward-only iteration discipline. No new method on `VirtualTableModule`; the advertised capability is what licenses the emitter to use the vtab in that role.

### Retrieve-node lifting

`RetrieveNode` (`packages/quereus/src/planner/nodes/retrieve-node.ts`) is the boundary between the vtab access plan and the rest of the optimizer. When `BestAccessPlanResult.monotonicOn` is present, the retrieve node populates `physical.monotonicOn` (the field added by `1-monotonic-on-characteristic`) so downstream rules see it. The lifting is mechanical: translate `columnIndex` into the corresponding output `attrId` and set strictness/direction from the result.

The `supportsOrdinalSeek` and `supportsAsofRight` flags are recorded on the retrieve node's physical properties under a nested `accessCapabilities` record (or equivalent) so downstream rules can consult them without re-running `getBestAccessPlan`.

### Module-author guidance

A module advertises monotonic ordering when its access path is backed by a sorted index over the column with no value duplicates within the path's emit order, and the column type's comparator agrees with the index's storage comparator. Examples:

- A B+tree index on `created_at` whose values are unique within the table → `monotonicOn: { columnIndex: <created_at>, direction: 'asc', strict: true }`.
- A sequence column backed by a counted B+tree (Lamina's case; see Lamina's `docs/sequences.md`) → same shape.
- A heap with a sorted secondary index that allows duplicate keys → `strict: false`; downstream rules either treat the column as a non-strict candidate or skip the rewrite.

A module advertises `supportsOrdinalSeek` when its index supports O(log N) seek to the kth entry without scanning. (B+trees with subtree counts; counted variants; some columnar formats.) Plain sorted indexes that require leaf-walking from the start to find offset k must not advertise it; the optimizer will still pick the path for non-pushdown LIMIT, but won't push.

A module advertises `supportsAsofRight` when its scan iterator supports forward-only progression after an initial seek without re-seeking per left-row. This is true for any sorted-index walk; advertising it is essentially "I'm sorted on this column, you can drive me as the right side of an asof."

### Memory-table reference implementation

`MemoryTable` (`vtab/memory/table.ts`) should advertise these where applicable for at least one test scenario, so the companion downstream tickets have a non-Lamina vtab to validate against. Initial coverage: a memory table with a sorted index on a unique column advertises `monotonicOn` (`strict: true`) and `supportsAsofRight`; ordinal seek is harder for a generic in-memory layered store and may be deferred.

### Diagnostics

`query_plan()` surfaces the new fields under the retrieve node's properties, named consistently (`monotonicOn`, `supportsOrdinalSeek`, `supportsAsofRight`). EXPLAIN consumers and downstream-rule diagnostics depend on this.

## TODO

### Phase 1: Interface
- Add the three optional fields to `BestAccessPlanResult` with the contract documented above.
- Document the `BestAccessPlanRequest.offset` interaction with `supportsOrdinalSeek` (no shape change, behavior clarified).

### Phase 2: Retrieve-node lifting
- In `RetrieveNode` physical-property derivation, lift `monotonicOn` into `physical.monotonicOn` (the field from `1-monotonic-on-characteristic`).
- Stash `supportsOrdinalSeek` / `supportsAsofRight` on retrieve node so downstream rules can consult them without round-tripping through the vtab.

### Phase 3: Reference implementation
- Wire memory-table to advertise `monotonicOn` and `supportsAsofRight` for sorted-unique-index access paths. Add a fixture used by downstream optimizer-rule tickets.

### Phase 4: Tests
- Unit tests for the lifting logic.
- Plan-shape tests confirming `physical.monotonicOn` appears on retrieve nodes whose access plan advertises it.
- Negative tests confirming non-strict and non-monotonic paths leave the field unset.
