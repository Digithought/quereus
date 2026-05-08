---
description: Add a MonotonicOn(attrId) plan characteristic — type, PhysicalProperties field, helpers, and propagation rules across the relational node set
files: packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/framework/characteristics.ts, packages/quereus/src/planner/framework/physical-utils.ts, packages/quereus/src/planner/nodes/sort.ts, packages/quereus/src/planner/nodes/distinct-node.ts, packages/quereus/src/planner/nodes/filter.ts, packages/quereus/src/planner/nodes/limit-offset.ts, packages/quereus/src/planner/nodes/project-node.ts, packages/quereus/src/planner/nodes/alias-node.ts, packages/quereus/src/planner/nodes/join-node.ts, packages/quereus/src/planner/nodes/merge-join-node.ts, packages/quereus/src/planner/nodes/set-operation-node.ts, packages/quereus/src/planner/nodes/hash-aggregate.ts, packages/quereus/src/planner/nodes/stream-aggregate.ts, packages/quereus/src/planner/nodes/window-node.ts, packages/quereus/test/optimizer/

---

## Architecture

`PhysicalProperties.ordering` already tracks per-column sort direction and propagates through trivial passthroughs. What it does not currently express is *"this relation is **strictly** ordered on attribute X under a non-decreasing total order, and that property survives a defined set of transformations."* Several worthwhile rewrites — ordinal-seek for `ORDER BY x LIMIT n OFFSET k`, lateral-top-1 → asof scan, merge join over aligned monotonic columns, adjacent-leaf reads for `LAG/LEAD` over a monotonic window — gate on this stronger property.

This ticket adds the property as a first-class plan characteristic and the propagation rules that carry it through the optimizer. The companion ticket `1-bestaccessplan-monotonic-ordering` (already in `implement/`) populates `physical.monotonicOn` from vtab access-plan advertisements at the leaves; this ticket installs the carrier and the propagation layer above the leaves.

### The characteristic shape

```ts
// packages/quereus/src/planner/framework/characteristics.ts

export interface MonotonicOnInfo {
  /** Attribute over which the relation is ordered. Stable across plan transformations. */
  readonly attrId: number;
  /** True iff the relation guarantees no two rows share the value of attrId. */
  readonly strict: boolean;
  /** Direction; default 'asc'. */
  readonly direction: 'asc' | 'desc';
}
```

It rides on `PhysicalProperties` as:

```ts
// packages/quereus/src/planner/nodes/plan-node.ts

export interface PhysicalProperties {
  // … existing fields …

  /**
   * Attributes the relation is monotonically ordered on. Stronger than `ordering`:
   * meaningful only for total-order-preserving sources (vtab access plans that
   * advertise it; sort nodes; certain merge operators) and survives only the
   * propagation rules documented in characteristics.ts.
   *
   * `monotonicOn` strictly implies `ordering` on the same attribute in the same
   * direction; nodes are permitted (not required) to populate one from the other.
   */
  monotonicOn?: readonly MonotonicOnInfo[];
}
```

A relation may be monotonic on multiple attributes simultaneously (e.g., a sequence column and a co-monotonic alias) — hence the array.

`PlanNodeCharacteristics` gains:

```ts
static getMonotonicOn(node: PlanNode): readonly MonotonicOnInfo[];
static isMonotonicOn(node: PlanNode, attrId: number): MonotonicOnInfo | undefined;
```

### Propagation rules

Each relational node's `computePhysical()` derives `monotonicOn` from its children using these rules. The default is **drop** (i.e., undefined output). Explicit propagation is required.

| Transformation | Rule |
| --- | --- |
| `Filter` (`σ_p`) | Preserve. A predicate doesn't reorder. |
| `LimitOffset` | Preserve. |
| `Sort(by=[X dir])` | If the sort is over the full input (non-windowed), set `MonotonicOn(X, strict = input-was-unique-on-X, direction = dir)`. Multi-key sorts establish `MonotonicOn` only on the leading key (and only when subsequent keys don't matter — i.e., strict iff input was unique on the leading key). |
| `Distinct` | Output is `MonotonicOn(X, strict=true, direction=dir)` whenever the input was `MonotonicOn(X, strict=false, direction=dir)`. Otherwise drop. (`Distinct` over an unordered input doesn't establish ordering.) |
| `Project` | For each source `MonotonicOn(srcAttrId)`, propagate to output iff `srcAttrId` is preserved in the projection (output projection emits a `ColumnReference` to that exact attribute, *not* a renamed copy through a non-trivial expression). Until `4-expression-properties-injective-monotone` lands, only trivial column-reference projections preserve. |
| `Alias` (`Rename`) | Preserve unchanged — alias does not change attribute IDs (it only changes presentation names). |
| `Inner Join` on equi-pair `l.X = r.X` where both `l` and `r` are `MonotonicOn(X)` | Preserve `MonotonicOn(X)` on the join's output side that retains attribute X (left's by convention; the rule applies symmetrically on the right). Strictness: `strict ∧ strict` of the two inputs. |
| `Inner/Outer Join` on any other condition | Drop. |
| `Outer Join` (`left`/`right`/`full`) | The null-extended side cannot remain monotonic on its X (NULLs disturb ordering). The preserved side: same rules as inner join's preserved side. |
| `Semi/Anti Join` | Preserve from the *left* side (semi/anti yield a subset of left, in left's order). |
| `Cross Join` | Drop on both sides — the cross product has no single-attribute monotonic ordering. |
| `MergeJoin` | Same rules as the corresponding `Join`, except: when the merge is on the equi-pair `l.X = r.X` and both inputs are `MonotonicOn(X)`, the result is `MonotonicOn(X)` (this is the merge join's whole point). Strictness as above. |
| `SetOperation` (UNION ALL, two `MonotonicOn(X)` inputs) | Drop in this ticket — the disjoint-range special case is interesting but requires range-bound reasoning that's out of scope. Document with an inline comment so the follow-up ticket can lift it. |
| `SetOperation` (UNION/INTERSECT/EXCEPT — set semantics) | Drop. |
| `HashAggregate` / `StreamAggregate` (`GROUP BY`) | Drop at the aggregation boundary; the grouped relation is a set. |
| `WindowFunction` (`PARTITION BY P ORDER BY X`) | Preserve from the input — the window node passes rows through; within a partition the input remains `MonotonicOn(X)`. |
| Anything else | Drop (conservative default). |

### Source nodes

`monotonicOn` enters the property graph at:

1. **Vtab access plans** — `IndexScanNode` / `IndexSeekNode` populate `physical.monotonicOn` from `BestAccessPlanResult.monotonicOn` (handled by `1-bestaccessplan-monotonic-ordering`).
2. **`Sort` nodes** — establish per the rule above.
3. **Future operators** (`OrdinalSlice`, `MonotonicMerge`, `AsofScan`) — declare it by construction in their `computePhysical()`.

This ticket is responsible only for #2 (and the propagation that #1 relies on landing).

### Strictness from input uniqueness

`Sort` on `X`: strict iff the input was unique on X. Detection: walk `sourcePhysical.uniqueKeys` looking for a key whose set is exactly `{X}` (or a subset that includes X as its sole member after projection through the source's attributes). For multi-column unique keys, `Sort` on a single column inside that key does not produce strict monotonic — drop strictness.

`Distinct`: strict by definition once the input was non-strict-but-ordered on X. The output of `Distinct` is unique on the deduplicated columns. The propagation rule above fires only when the input was already monotonic — `Distinct` over an unordered input produces a uniqueness guarantee but no ordering.

### Helpers

A small helper module simplifies the rules. Add to `physical-utils.ts`:

```ts
export function projectMonotonicOnByAttrId(
  monotonicOn: readonly MonotonicOnInfo[] | undefined,
  preservedAttrIds: ReadonlySet<number>,
): readonly MonotonicOnInfo[] | undefined;

export function intersectMonotonicOn(
  left: readonly MonotonicOnInfo[] | undefined,
  right: readonly MonotonicOnInfo[] | undefined,
): readonly MonotonicOnInfo[] | undefined;

export function deriveOrderingFromMonotonicOn(
  monotonicOn: readonly MonotonicOnInfo[] | undefined,
  attrs: readonly { id: number }[],
): { column: number; desc: boolean }[] | undefined;
```

These keep node-level `computePhysical` overrides short.

### Diagnostics

`query_plan()` emits `node.physical` via `safeJsonStringify` (see `packages/quereus/src/func/builtins/explain.ts:160`). Once `monotonicOn` is in `PhysicalProperties` it appears automatically in EXPLAIN output. Verify in tests; no emit-side change required.

### Backwards compatibility

Adding `monotonicOn` to `PhysicalProperties` is purely additive. Nodes that don't populate it default to `undefined` (no monotonic guarantee), which is the safe behavior. No existing rule needs to be aware of the new field; rules that want to *use* it explicitly check.

## TODO

### Phase 1: Carrier
- Add `MonotonicOnInfo` interface in `packages/quereus/src/planner/framework/characteristics.ts`.
- Add `monotonicOn?: readonly MonotonicOnInfo[]` to `PhysicalProperties` in `packages/quereus/src/planner/nodes/plan-node.ts`.
- Add `PlanNodeCharacteristics.getMonotonicOn` and `PlanNodeCharacteristics.isMonotonicOn` (mirror the `ordering` accessors).
- Add `projectMonotonicOnByAttrId`, `intersectMonotonicOn`, `deriveOrderingFromMonotonicOn` helpers in `packages/quereus/src/planner/framework/physical-utils.ts`.
- Verify nothing in the explain path needs additional wiring (the JSON serialization is automatic).

### Phase 2: Propagation in computePhysical
Touch each node's `computePhysical` to apply the rules above. Keep changes mechanical:

- `sort.ts` — establish `monotonicOn` from the leading sort key when it is a trivial column reference; strict based on `sourcePhysical.uniqueKeys`. Re-use `extractOrderingFromSortKeys` to identify the leading attrId. (No `monotonicOn` if leading key is not a trivial column reference.)
- `distinct-node.ts` — promote source's non-strict `monotonicOn` to strict.
- `filter.ts` — preserve `sourcePhysical.monotonicOn` unchanged.
- `limit-offset.ts` — preserve.
- `project-node.ts` — filter source's `monotonicOn` to attributes that survive projection (the projection emits a `ColumnReference` to that exact attrId).
- `alias-node.ts` — preserve unchanged (attribute IDs are stable).
- `join-node.ts` — apply the inner/outer/semi/anti rules. The existing `extractEquiPairsFromCondition` helper gives the equi-pair set; preserve `MonotonicOn(X)` on the preserved side iff some pair's attrId on that side matches. Outer-join NULL-extension: drop on the null-extended side.
- `merge-join-node.ts` — same as `join-node`, except when the merge equi-pair includes attrId X and both inputs are `MonotonicOn(X)`, propagate intersection (strict ∧ strict).
- `set-operation-node.ts` — drop in this ticket. Add an inline `// TODO: UNION ALL with disjoint X-ranges could preserve` comment so the follow-up sees it.
- `hash-aggregate.ts`, `stream-aggregate.ts` — drop. Inline `monotonicOn: undefined` in the override (or simply omit — undefined is the default).
- `window-node.ts` — preserve from source. (Within a partition the input remains monotonic; the window node does not reorder.)

For each node, write the `monotonicOn` derivation in the same `computePhysical` block as the existing `ordering` derivation, so future readers see the two side by side.

### Phase 3: Tests
Add to `packages/quereus/test/optimizer/`. Each test asserts on `physical.monotonicOn` of the relevant plan node, using the existing plan-introspection patterns in that folder.

- **Source establishment (Sort)** — `select * from t order by x` over a memory-table, where `t` is unique on `x`: `Sort` node's `physical.monotonicOn` includes `{ attrId: <x>, strict: true, direction: 'asc' }`. Same query on a non-unique `t.x`: `strict: false`.
- **Distinct strengthens** — `select distinct x from (select x from t order by x)`: the `Distinct` node's `physical.monotonicOn` is `{ strict: true, … }` even when the source `Sort` was non-strict.
- **Filter preserves** — adding `where p` over a monotonic source does not drop `monotonicOn`.
- **Project preserves attrId-stable**: `select x, y from (… monotonicOn x …)` — `monotonicOn` survives. `select y from (… monotonicOn x …)` — drops (X is not projected).
- **Project drops through non-trivial expression**: `select x + 1 as x_plus from (… monotonicOn x …)` — drops (until expression-properties land).
- **Alias preserves**: `select x as alias_x from (… monotonicOn x …)` — preserves (the underlying attrId survives).
- **Limit/Offset preserves**.
- **Inner join on monotonic equi-pair**: both inputs `MonotonicOn(X)`, joined on `l.x = r.x` → preserved on the left side.
- **Inner join on non-equi or non-monotonic**: dropped.
- **Outer join, null-extended side**: dropped on the extended side, preserved on the other.
- **Semi join**: preserves left's `monotonicOn`.
- **Cross join**: drops.
- **Merge join on monotonic equi-pair**: preserves with strict-AND.
- **Set operations**: all set ops drop in this ticket. Confirm with one `union` and one `union all` test.
- **Aggregation**: GROUP BY drops.
- **Window function**: preserves source's `monotonicOn`.
- **EXPLAIN serialization**: one end-to-end test confirming `query_plan()` output's `physical` JSON column includes a `monotonicOn` field on a representative plan (e.g., `select * from t order by x` over a unique-PK memory table once `1-bestaccessplan-monotonic-ordering` lands; until then, the Sort-node-driven test exercises the same JSON path).

The test harness should rely on a memory-table fixture rather than mocking — once `1-bestaccessplan-monotonic-ordering` lands, the same fixtures verify end-to-end advertisement-to-propagation.

Note on prereq: this ticket can land independently of `1-bestaccessplan-monotonic-ordering`. The propagation rules are testable using `Sort` as the establishment point (since memory tables won't yet advertise `monotonicOn` until the bestaccessplan ticket lands). Tests that require leaf-side advertisement should be marked `it.skip` with a reference to the bestaccessplan ticket, or moved into that ticket's test set.

### Validation
- `yarn build` then `yarn test 2>&1 | tee /tmp/test.log` — no regressions.
- `yarn lint` (quereus only) for style.
