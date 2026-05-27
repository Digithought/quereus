description: Review the migration of ad-hoc `attrs.findIndex(a => a.id === …)` attribute-index scans to the cached `RelationalPlanNode.getAttributeIndex()` surface. No-behavior-change DRY refactor.
files: packages/quereus/src/planner/nodes/sort.ts, packages/quereus/src/planner/nodes/window-node.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/planner/nodes/aggregate-node.ts, packages/quereus/src/planner/nodes/hash-aggregate.ts, packages/quereus/src/planner/nodes/stream-aggregate.ts, packages/quereus/src/runtime/emit/bloom-join.ts, packages/quereus/src/runtime/emit/merge-join.ts, packages/quereus/src/runtime/emit/asof-scan.ts, packages/quereus/src/planner/util/key-utils.ts
----

## What changed

Migrated the remaining in-scope hand-rolled `findIndex(a => a.id === id)` attribute-index scans to `RelationalPlanNode.getAttributeIndex().get(id) ?? -1`. Pure consistency/DRY cleanup — no behavior change expected, and none observed (full suite green, no `.sqllogic`/optimizer-spec diffs).

### Group A — direct node-in-hand swaps
- `nodes/sort.ts` (~L88): `sourceAttributes.findIndex(...)` → `this.source.getAttributeIndex().get(leadAttrId) ?? -1`. `sourceAttributes` local kept (still used by `extractOrderingFromSortKeys` and `isAssertedKey(..., sourceAttributes.length)`).
- `nodes/window-node.ts` (~L262): same swap; `sourceAttrs` kept for `.length`.
- `nodes/reference.ts` `getColumnIndexForAttribute`: collapsed body to `return this.getAttributeIndex().get(attributeId);` — returns `undefined` on miss, matching prior contract.

### Group B — runtime emitters
Captured index map(s) once before the loop, `.get(attrId) ?? -1` inside; attribute arrays kept where still needed (row descriptors, collation lookup, col counts); `=== -1` throw-on-unresolved guards preserved verbatim.
- `runtime/emit/bloom-join.ts`: added `leftIndex`/`rightIndex`.
- `runtime/emit/merge-join.ts`: same.
- `runtime/emit/asof-scan.ts` `resolveSetup`: added `leftIndex`/`rightIndex`, used for both the match-attr pair and the partition-attr loop.

### Group C — `propagateAggregateFds` signature change
- Parameter `sourceAttrs: readonly Attribute[]` → `sourceAttrIndex: ReadonlyMap<number, number>`; internal lookup now `sourceAttrIndex.get(expr.attributeId) ?? -1`.
- All three callers updated to pass `this.source.getAttributeIndex()`: `AggregateNode`, `HashAggregateNode`, `StreamAggregateNode` `computePhysical`. Reference search confirmed no other callers.
- `Attribute` import in aggregate-node.ts retained (still used by other signatures — `attributesCache`, `preserveAttributeIds`, `buildAttributes`, etc.).

### Group D — decisions
- `nodes/util/key-utils.ts` `deriveProjectionColumnMap`: **left as-is** per ticket guidance. It is a pure helper with no owning node, called directly by `test/optimizer/keys-propagation.spec.ts` with hand-built `Attribute[]`; migrating would either ripple the signature into the unit test or build a local map (a micro-opt not using the cached surface). Added a one-line comment documenting why.
- `createTableInfoFromNode`: untouched (builds its `columnIndexMap` in the same pass — no scan to eliminate; out of scope).

## Verification performed
- `yarn workspace @quereus/quereus run build` — clean (exit 0). The `propagateAggregateFds` signature change is the only thing that could break compilation; all three callers compile.
- `yarn test` — full workspace suite green: 3591 passing / 9 pending in quereus, plus other packages passing. (The `failingKv` string in the log is a sync-package test fixture name, not a failure.)
- `yarn workspace @quereus/quereus run lint` — clean (exit 0).

## Review focus / known gaps
- Verification relied on existing coverage (this is a no-behavior-change refactor). `test/optimizer/keys-propagation.spec.ts` and `test/planner/attribute-provenance.spec.ts` both pass. No new tests added — there is no new behavior to cover.
- Worth a sanity check: the `?? -1` translation preserves the exact miss semantics everywhere (historical scans returned `-1`; reference.ts intentionally returns `undefined`). Confirm no caller distinguishes "id present but maps to index 0" from a miss — `getAttributeIndex()` maps real attrs to real indices so this is safe, but it's the one subtle spot.
- Out-of-scope `findIndex` sites in rules/analysis (`constraint-extractor.ts`, `physical-utils.ts`, several `rules/**`) were deliberately not touched; a follow-up `backlog/` ticket would be the place if that cleanup is wanted.
