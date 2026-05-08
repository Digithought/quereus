---
description: Add a MonotonicOn(attrId) plan characteristic and its propagation rules so the optimizer can carry "this relation is monotonically ordered on attribute X" through plan transformations
files: packages/quereus/src/planner/framework/characteristics.ts, packages/quereus/src/planner/nodes/plan-node.ts (PhysicalProperties), packages/quereus/src/planner/analysis/

---

## Architecture

The optimizer already tracks ordering through `PhysicalProperties.ordering` (an array of `{ column, desc }`) and propagates it for trivial passthroughs. What it does not currently express is: *"this relation is **strictly** ordered on attribute X under a non-decreasing total order, and that property survives a defined set of transformations."* Several worthwhile rewrites — ordinal-seek for `ORDER BY x LIMIT n OFFSET k`, lateral-top-1 → asof scan, merge join over aligned monotonic columns, adjacent-leaf reads for `LAG/LEAD` over a monotonic window — all gate on this stronger property.

This ticket adds the property as a first-class plan characteristic and the propagation rules that carry it through the optimizer.

### The characteristic

```ts
// packages/quereus/src/planner/framework/characteristics.ts

export interface MonotonicOnInfo {
  /** Attribute over which the relation is ordered */
  readonly attrId: number;
  /** True iff the relation guarantees no two rows share the value of attrId */
  readonly strict: boolean;
  /** Direction; default 'asc' */
  readonly direction: 'asc' | 'desc';
}

export class PlanNodeCharacteristics {
  /**
   * Returns each (attrId, info) the node guarantees monotonic-on. A plan may
   * be monotonic on multiple attributes simultaneously (e.g., a sequence column
   * joined to itself by another monotonic key).
   */
  static getMonotonicOn(node: PlanNode): readonly MonotonicOnInfo[];

  /** Convenience: "is this node monotonic on attrId?" */
  static isMonotonicOn(node: PlanNode, attrId: number): MonotonicOnInfo | undefined;
}
```

The information is carried on the node's `PhysicalProperties` (sibling to `ordering`/`uniqueKeys`) as a `monotonicOn?: readonly MonotonicOnInfo[]` field. `MonotonicOn` strictly implies `ordering` on the same attribute in the same direction; the optimizer is permitted to derive one from the other when populating physical properties, but `MonotonicOn` is stronger because it is meaningful only for total-order-preserving sources (vtab access plans that advertise it; sort nodes; certain merge operators).

### Propagation rules

The optimizer needs uniform rules for how `MonotonicOn(attrId)` survives plan-tree transformations. These mirror the ordering-propagation rules but with stricter preconditions and a fail-closed default.

| Transformation | Effect on `MonotonicOn(X)` |
| --- | --- |
| Filter (`σ_p`) | Preserves. A predicate doesn't reorder. |
| Project keeping X | Preserves. |
| Project not keeping X | Drops. The result has no ordering on X because X is gone. |
| Project through an injective+monotone scalar over X (`f(X)` keeping X→f(X) renaming) | Preserves under f's direction (see `4-expression-properties-injective-monotone` once it lands; until then, conservative drop). |
| Rename | Preserves (with attribute rewriting). |
| Sort (`ORDER BY X`) | Establishes `MonotonicOn(X)` if the sort is over the full input; the result is non-decreasing on X but **not** strict unless the input was unique on X. |
| Distinct on X | Establishes strict `MonotonicOn(X)` over a previously non-strict one. |
| Limit/Offset | Preserves. |
| Inner join on `l.X = r.X` where both inputs are `MonotonicOn(X)` | Preserves. The result is monotonic on X (either side's X — they agree). |
| Inner join on any other condition | Drops. |
| Outer join | Drops on the X-side iff the X-side may be the null-extended side; preserves on the preserved side. |
| `UNION ALL` of two `MonotonicOn(X)` inputs with disjoint X-ranges | Preserves (this is concat). The optimizer recognizes the disjoint-range case from `<` constraints between the inputs' max/min. |
| `UNION ALL` with overlapping ranges | Drops. |
| `UNION` (set), `INTERSECT`, `EXCEPT` | Drops. |
| `GROUP BY` | Drops at the boundary; the grouped relation is a set. |
| `WINDOW` partition (`PARTITION BY P ORDER BY X`) | Within a partition, the input remains `MonotonicOn(X)`. |

The rules are mechanical. A small visitor over the node's children's `monotonicOn` fields, applied once during physical-property derivation, suffices. The cost is O(plan size).

### Sources of `MonotonicOn`

A node acquires `MonotonicOn(X)` from one of:

1. **A vtab access plan that advertises it** — see `1-bestaccessplan-monotonic-ordering`. The retrieve node populates `physical.monotonicOn` from `BestAccessPlanResult`.
2. **A `Sort` node** — establishes non-strict; combine with downstream `Distinct` for strict.
3. **An operator that produces it by construction** — `MonotonicMerge`, `OrdinalSlice`, `AsofScan` (downstream tickets). Each declares the property in its emitted physical properties.

### Use cases

The characteristic exists to license:

- **`ORDER BY x LIMIT n OFFSET k` → ordinal seek** when the input is `MonotonicOn(x)` and the access plan advertises ordinal-seek support.
- **Lateral-top-1 with `<=` on monotonic + equi-partition → streaming asof scan**.
- **Equi-join on `l.X = r.X` where both sides are `MonotonicOn(X)` → merge join**.
- **`LAG/LEAD(...) OVER (... ORDER BY x)` → adjacent-leaf reads** when the windowed input is `MonotonicOn(x)`.
- **`WHERE x BETWEEN a AND b` → range scan** (already partly covered by ordering, but `MonotonicOn` makes the bound-tightness deterministic for the optimizer).

These all land as separate downstream tickets; this one establishes the carrier.

### Adapter visibility

`MonotonicOn` is purely an optimizer-internal characteristic. Vtab modules don't manipulate it directly — they advertise their access path's properties through `BestAccessPlanResult` (companion ticket), and the retrieve-node code translates that advertisement into `physical.monotonicOn`. This keeps the property's contract centralized.

### Backwards compatibility

Adding `monotonicOn` to `PhysicalProperties` is purely additive. Existing nodes that don't populate it default to `undefined` (i.e., no monotonic guarantee), which is the conservative behavior. No existing rule needs to be aware of the new field; rules that want to *use* it explicitly check.

### Diagnostics

`query_plan()` should surface `monotonicOn` alongside `ordering` in the JSON properties so downstream tickets and EXPLAIN consumers can verify propagation. The format mirrors `ordering`.

## TODO

### Phase 1: Wire the characteristic
- Add `monotonicOn?: readonly MonotonicOnInfo[]` to `PhysicalProperties`.
- Add `MonotonicOnInfo` type and `getMonotonicOn` / `isMonotonicOn` helpers in `characteristics.ts`.
- Surface `monotonicOn` in the JSON properties exposed by `query_plan()`.

### Phase 2: Propagation
- Implement the propagation table above as a small derivation pass on physical-property assembly. Populate `monotonicOn` on each relational plan node based on its children, transformation, and additional info available locally (rename maps, projection lists, predicate constraints).
- Cover JOIN, UNION ALL, FILTER, PROJECT, SORT, DISTINCT, LIMIT, GROUP BY, WINDOW, RENAME at minimum. Conservative drop for anything else.

### Phase 3: Tests
- Plan-shape tests confirming the characteristic propagates through each transformation as specified.
- Plan-shape tests confirming it correctly *drops* through GROUP BY, set operations, projection-without-the-attribute, and joins not on the monotonic attribute.
- Tests with synthetic vtabs (memory-table or a test fixture) advertising `MonotonicOn` via the access plan, verifying the retrieve node lifts the advertisement into physical properties.
