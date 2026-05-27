description: Migrate the remaining ad-hoc `attrs.findIndex(a => a.id === …)` attribute-index scans to the cached `RelationalPlanNode.getAttributeIndex()` surface. DRY/consistency cleanup, not a correctness fix.
files: packages/quereus/src/planner/nodes/sort.ts, packages/quereus/src/planner/nodes/window-node.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/planner/nodes/aggregate-node.ts, packages/quereus/src/planner/nodes/hash-aggregate.ts, packages/quereus/src/planner/nodes/stream-aggregate.ts, packages/quereus/src/runtime/emit/bloom-join.ts, packages/quereus/src/runtime/emit/merge-join.ts, packages/quereus/src/runtime/emit/asof-scan.ts, packages/quereus/src/planner/util/key-utils.ts
effort: low
----

## Background

`attribute-provenance-surface` added `RelationalPlanNode.getAttributeIndex(): ReadonlyMap<number, number>` — a per-instance, lazily-built, cached `attrId → index` map (`packages/quereus/src/planner/nodes/plan-node.ts:494`). It is declared on the `RelationalPlanNode` interface (`plan-node.ts:657`), so any value typed as `RelationalPlanNode` (including emitter `plan.left`/`plan.right` and node `this.source`) can call it. The contract on miss is `.get(id) === undefined`; the historical hand-rolled scan returned `-1`, so the standard replacement is:

```ts
attrs.findIndex(a => a.id === id)   →   node.getAttributeIndex().get(id) ?? -1
```

`bloom-join-node`, `merge-join-node`, and `rule-monotonic-range-access` were already migrated and are the reference pattern (see `bloom-join-node.ts:65-70`, `rule-monotonic-range-access.ts:97-99`). This ticket finishes the remaining in-scope sites.

## Site inventory

### Group A — direct node-in-hand swaps (mechanical)

Each scans a node's attribute list for a single attrId; the owning node is right there.

- **`nodes/sort.ts` (~line 88)** — `computePhysical`. `sourceAttributes.findIndex(a => a.id === leadAttrId)` → `this.source.getAttributeIndex().get(leadAttrId) ?? -1`. Keep the `sourceAttributes` local — it is still used by `extractOrderingFromSortKeys` and `isAssertedKey(..., sourceAttributes.length)`.
- **`nodes/window-node.ts` (~line 262)** — `computePhysical`, empty-PARTITION-BY/ORDER-BY branch. `sourceAttrs.findIndex(a => a.id === leadAttrId)` → `this.source.getAttributeIndex().get(leadAttrId) ?? -1`. Keep `sourceAttrs` (used for `.length`).
- **`nodes/reference.ts` (~line 232)** — `TableReferenceNode.getColumnIndexForAttribute`. This one already returns `undefined`-on-miss, so collapse the whole body to `return this.getAttributeIndex().get(attributeId);` and drop the `attrs`/`idx` locals.

### Group B — runtime emitters (node-in-hand; ticket caveat does NOT apply here)

These hold `plan.left` / `plan.right`, both `RelationalPlanNode`. Capture the index map(s) once before the loop, then `.get(attrId) ?? -1` inside. Preserve the existing `=== -1` throw-on-unresolved guards verbatim.

- **`runtime/emit/bloom-join.ts` (~lines 32-33)** — equi-pair loop: `leftAttributes.findIndex` / `rightAttributes.findIndex`. `leftAttributes`/`rightAttributes` are still needed for `buildRowDescriptor`, collation lookup (`leftAttributes[li].type...`), and `rightColCount` — keep them; add `const leftIndex = plan.left.getAttributeIndex();` etc.
- **`runtime/emit/merge-join.ts` (~lines 56-57)** — same shape as bloom-join.
- **`runtime/emit/asof-scan.ts` (~lines 45-46 and ~58-59)** — `resolveSetup`: match-attr pair (`leftMatchIdx`/`rightMatchIdx`) and the partition-attr loop. Both resolve against `leftAttrs`/`rightAttrs` (= `plan.left/right.getAttributes()`); keep those arrays (used for row descriptors and collation), add the two index maps.

### Group C — raw-array free function, cleanly threadable

- **`nodes/aggregate-node.ts` `propagateAggregateFds`** — takes `sourceAttrs: readonly Attribute[]` purely to do one `sourceAttrs.findIndex(...)` inside the `groupBy.forEach`. Replace that parameter with `sourceAttrIndex: ReadonlyMap<number, number>` and rewrite the lookup to `sourceAttrIndex.get(expr.attributeId) ?? -1`. Update its **three** callers to pass `this.source.getAttributeIndex()` instead of `this.source.getAttributes()`:
  - `nodes/aggregate-node.ts` `AggregateNode.computePhysical`
  - `nodes/hash-aggregate.ts` `HashAggregateNode.computePhysical`
  - `nodes/stream-aggregate.ts` `StreamAggregateNode.computePhysical`
  No other callers exist (confirmed via reference search). The `Attribute` import in aggregate-node.ts may still be needed for other signatures — check before removing.

### Group D — evaluate, likely leave (document the decision)

- **`nodes/util/key-utils.ts` `deriveProjectionColumnMap`** — a pure helper over `sourceAttrs: readonly Attribute[]` with two `findIndex` passes (bare-column + injective). It is called by `ProjectNode` and `ReturningNode` (which DO have nodes) **but also directly by the unit test `test/optimizer/keys-propagation.spec.ts` with hand-built `Attribute[]`**. There is no owning node inside the helper, so migrating to `getAttributeIndex()` means either changing the signature (rippling into the unit test, which would have to synthesize a map) or building a local map inside (a micro-opt that does *not* use the cached surface). Per the ticket's "evaluate before touching / marginal gain" guidance, the recommendation is to **leave this as-is** unless the implementer finds the signature change clean. If left, add a one-line comment noting why (`// pure helper: no owning node; callers pass raw attrs incl. unit tests`). Either way, document the choice in the review handoff.
- **`createTableInfoFromNode`** (mentioned in the original plan) builds its `columnIndexMap` in the same pass as the `{id,name}` list, so there is no scan to eliminate — **out of scope, do not touch.**

## Out of scope (do not migrate in this ticket)

Other `findIndex(a => a.id === …)` sites exist in rules and analysis (`constraint-extractor.ts`, `physical-utils.ts deriveOrderingFromMonotonicOn`, `rules/join/equi-pair-extractor.ts`, `rule-aggregate-streaming.ts`, `rule-join-physical-selection.ts`, `rule-lateral-top1-asof.ts`, `rule-aggregate-predicate-pushdown.ts`, `rule-grow-retrieve.ts`, `rule-orderby-fd-pruning.ts`, `rule-monotonic-window.ts`). Several operate on raw arrays or non-`this` source nodes and need case-by-case judgement. They are not in this ticket's `files:` scope; if cleanup there is wanted, file a follow-up `backlog/` ticket. Don't grow this pass.

## Verification

This is a no-behavior-change refactor; existing coverage is sufficient. Expect no `.sqllogic` or optimizer-spec diffs.

- `yarn workspace @quereus/quereus run build` (type-check — the `propagateAggregateFds` signature change is the only one that can break compilation; confirm all three callers updated).
- `yarn test 2>&1 | tee /tmp/test.log; tail -n 80 /tmp/test.log` — full quereus suite. Watch `test/optimizer/keys-propagation.spec.ts` (covers `deriveProjectionColumnMap`) and `test/planner/attribute-provenance.spec.ts` (covers `getAttributeIndex`) in particular.
- `yarn workspace @quereus/quereus run lint` (single-quote globs on Windows).

## TODO

- [ ] Group A: swap `sort.ts`, `window-node.ts`, `reference.ts` to `getAttributeIndex().get(id) ?? -1` (reference.ts: collapse to `.get(attributeId)` returning undefined).
- [ ] Group B: thread index maps through the three emitters (`bloom-join`, `merge-join`, `asof-scan`); keep the attribute arrays where still used; preserve unresolved-id throw guards.
- [ ] Group C: change `propagateAggregateFds` to take `sourceAttrIndex: ReadonlyMap<number,number>`; update the three aggregate-node callers.
- [ ] Group D: decide on `deriveProjectionColumnMap` (default: leave + comment); confirm `createTableInfoFromNode` untouched.
- [ ] Build, full test suite, lint all green; note the Group D decision in the review handoff.
