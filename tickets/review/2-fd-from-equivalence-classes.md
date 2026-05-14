---
description: Review the constant-binding companion layer added to the FD/EC framework. Parameters now count as per-execution constants; bindings are closed over ECs at Filter and inner-join contribution points; every relational operator propagates bindings per its FD/EC rule.
prereq: fd-property-foundation
files:
  - packages/quereus/src/planner/util/fd-utils.ts
  - packages/quereus/src/planner/nodes/plan-node.ts
  - packages/quereus/src/planner/nodes/filter.ts
  - packages/quereus/src/planner/nodes/join-utils.ts
  - packages/quereus/src/planner/nodes/join-node.ts
  - packages/quereus/src/planner/nodes/merge-join-node.ts
  - packages/quereus/src/planner/nodes/bloom-join-node.ts
  - packages/quereus/src/planner/nodes/project-node.ts
  - packages/quereus/src/planner/nodes/returning-node.ts
  - packages/quereus/src/planner/nodes/alias-node.ts
  - packages/quereus/src/planner/nodes/distinct-node.ts
  - packages/quereus/src/planner/nodes/aggregate-node.ts
  - packages/quereus/src/planner/nodes/stream-aggregate.ts
  - packages/quereus/src/planner/nodes/hash-aggregate.ts
  - packages/quereus/src/planner/nodes/window-node.ts
  - packages/quereus/src/planner/nodes/asof-scan-node.ts
  - packages/quereus/src/planner/nodes/set-operation-node.ts
  - packages/quereus/src/planner/nodes/table-access-nodes.ts
  - packages/quereus/test/optimizer/fd-equivalence.spec.ts
  - docs/optimizer.md
---

## What landed

This ticket finished the EC layer left over from `fd-property-foundation`. Two related pieces shipped:

1. **Parameters as constants.** `extractEqualityFds` now recognizes `WHERE col = ?` (and `:foo`) as a constant predicate. The `constantValueOf` helper peels through `CastNode` / `CollateNode` wrappers (the parser inserts a numeric-cast around `?` when the column is numeric — without the peel the parameter case would never fire). LiteralNode + ParameterReferenceNode both produce a `∅ → col` FD; only parameters were missing before.

2. **`ConstantBinding` surface.** A new optional `constantBindings?` field on `PhysicalProperties` records, for each pinned column, the actual value it is pinned to (literal or parameter ref). The shape is:

   ```ts
   type ConstantValue =
     | { kind: 'literal'; value: SqlValue }
     | { kind: 'parameter'; paramRef: string | number };

   interface ConstantBinding {
     attrs: readonly number[];   // every column known to equal `value`
     value: ConstantValue;
   }
   ```

   `ConstantValue` / `ConstantBinding` live in `plan-node.ts` (the canonical home for FD-layer types) and are re-exported from `fd-utils.ts` for ergonomics.

### Helpers added (fd-utils.ts)

- `mergeConstantBindings(a, b)` — coalesces bindings sharing a `ConstantValue` by unioning `attrs`. Enforces the same per-node cap as FDs (`MAX_FDS_PER_NODE = 64`); truncations are logged under `quereus:planner:fd`.
- `closeConstantBindingsOverEcs(bindings, ecs)` — extends each binding's `attrs` over every overlapping EC member. This is the surface predicate-inference rules read: a binding `{[t.k], 5}` plus an EC `{t.k, u.k}` lands as `{[t.k, u.k], 5}`.
- `projectConstantBindings(bindings, mapping)` / `shiftConstantBindings(bindings, offset)` — projection and column-index translation mirrors of the FD/EC variants.

### Propagation table (mirrors the FD/EC rule per operator)

| Operator | Bindings rule |
| --- | --- |
| Filter | Inherit child + add predicate-derived bindings (literal + parameter). Close over the merged EC list. |
| Inner / Cross join | Union of left and right bindings (right shifted). Close over the merged EC list. |
| Left outer | Left's bindings only (NULL-pad invalidates right). |
| Right outer | Mirror of left outer. |
| Full outer | Drop both (conservative). |
| Semi / Anti | Left's bindings only. |
| Project / Returning | Project bindings through the source→output column mapping. |
| Alias / Distinct | Pass through unchanged. |
| Aggregate / StreamAggregate / HashAggregate | Project bindings onto the GROUP BY column mapping; aggregate output columns have none. |
| SetOperation | Drop conservatively (UNION can mix differing values). |
| Window | Pass through unchanged. |
| AsofScan | Inherit left only (right side is dropped — at-most-one match + NULL-pad). |
| SeqScan / IndexScan / IndexSeek | Pass through child's bindings. |

### Validation

- `yarn build` (tsc both `tsconfig.json` and `tsconfig.test.json`) — clean.
- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn test` (quereus) — **2776 passing, 2 pending, 0 failing**. The new `fd-equivalence.spec.ts` adds 22 tests covering: unit-level extractor / merge / closure / project / shift; end-to-end Filter / inner-join / left-outer / project propagation through `query_plan(?)` introspection.
- `yarn test:store` — not run (metadata-only change; skip per ticket spec).

## Use cases / test coverage worth a second look

- **Cast-wrapped parameter (`WHERE numeric_col = ?`):** the parser inserts a `CAST(? AS INTEGER)`; `constantValueOf` peels through CastNode / CollateNode so the parameter case still fires. Worth verifying this peel handles every wrapping the parser might insert (and that it stays correct if/when more coercions land).
- **EC closure on bindings:** `WHERE a = b AND a = 7` should produce a single binding `{[a, b], 7}`, not two. Tested in `fd-equivalence.spec.ts` under "closes binding over EC".
- **Join binding propagation:** `SELECT ... FROM jl JOIN jr ON jl.k = jr.k WHERE jl.k = 5` should expose a binding `{[jl.k, jr.k], 5}` somewhere at or above the join. Reviewer should confirm this works whether the filter is pushed into the left side or stays on top — both shapes hit the closure correctly because `Filter` and `propagateJoinFds` each call `closeConstantBindingsOverEcs`.
- **LEFT-outer drop:** ON clause `ro.k = 5` on the nullable side must NOT survive on the join output. Tested.
- **Project drops unprojected columns' bindings.** Tested.

## Out of scope (still deferred)

- Refining the outer-join EC/binding survival rule per the join-key-preservation refinement — tracked separately.
- Wiring downstream consumers (`rule-predicate-inference-equivalence`, ordering inference) — they read `constantBindings` directly in their own tickets.

## Reviewer checklist

- [ ] Inspect interface points first: extractor return shape, helper signatures, the per-operator wiring (look at one or two nodes; the others should be uniform).
- [ ] Confirm the cast/collate peel in `constantValueOf` is the right boundary — anything else that wraps a constant value should also be peeled, or explicitly rejected.
- [ ] Confirm `mergeConstantBindings` cap behaviour matches the FD cap convention (oldest dropped, log on `quereus:planner:fd`).
- [ ] Confirm `closeConstantBindingsOverEcs` terminates on overlapping ECs (it does — bounded by EC list size; the test "chains through multiple ECs transitively" exercises the iteration).
- [ ] Re-run `yarn test` and confirm green.
