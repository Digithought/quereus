description: Finish the DRY migration of ad-hoc `findIndex(a => a.id === …)` attribute-index scans to the cached `RelationalPlanNode.getAttributeIndex()` surface. The first pass (migrate-attribute-index-consumers) covered nodes + runtime emitters + propagateAggregateFds; this covers the remaining sites in optimizer rules and analysis.
files: packages/quereus/src/planner/analysis/constraint-extractor.ts, packages/quereus/src/planner/framework/physical-utils.ts, packages/quereus/src/planner/rules/join/equi-pair-extractor.ts, packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts, packages/quereus/src/planner/rules/join/rule-lateral-top1-asof.ts, packages/quereus/src/planner/rules/aggregate/rule-aggregate-streaming.ts, packages/quereus/src/planner/rules/predicate/rule-aggregate-predicate-pushdown.ts, packages/quereus/src/planner/rules/sort/rule-orderby-fd-pruning.ts, packages/quereus/src/planner/rules/window/rule-monotonic-window.ts, packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts
----

## Motivation

`RelationalPlanNode.getAttributeIndex()` (defined on `PlanNode`, `packages/quereus/src/planner/nodes/plan-node.ts`) provides a cached `attrId → columnIndex` map that replaces the ad-hoc linear `attrs.findIndex(a => a.id === id)` scans scattered across the planner. The first migration pass (`migrate-attribute-index-consumers`) converted the in-scope node + runtime-emitter sites and the `propagateAggregateFds` signature. A number of `findIndex(a => a.id === …)` sites were deliberately left untouched as out of scope; this ticket finishes the job.

This is a no-behavior-change consistency/DRY cleanup. Each scan returns the same column index; the only translation is `getAttributeIndex().get(id) ?? -1` (for callers that treat `-1`/`< 0` as "not found") or `.get(id)` directly (for callers that want `undefined` on miss).

## Known remaining sites

Sites identified during review of the first pass (search `findIndex(a => a.id` under `packages/quereus/src`):

- `planner/analysis/constraint-extractor.ts` — two scans over `sourceAttrs` (group-by → source col, table-col → source col). Has the source node in hand (`aggNode.source`).
- `planner/framework/physical-utils.ts` `deriveOrderingFromMonotonicOn` — scans a passed-in `attrs: readonly { id: number }[]`. Helper takes a raw array, not a node; migrating means either passing the map in from callers (most have the node) or leaving as-is. Evaluate per-caller.
- `planner/rules/join/equi-pair-extractor.ts` — `isOrderedOnEquiPairs`, `reorderEquiPairsForMerge` both have `source`/`left`/`right` nodes in hand.
- `planner/rules/join/rule-join-physical-selection.ts` `createSortForEquiPairs` — has `source` in hand.
- `planner/rules/join/rule-lateral-top1-asof.ts` — `tableRef.getAttributes().findIndex(...)`; node in hand.
- `planner/rules/aggregate/rule-aggregate-streaming.ts` `isOrderedForGrouping` — takes `sourceAttributes: readonly { id: number }[]`; evaluate whether to thread the node/map through.
- `planner/rules/predicate/rule-aggregate-predicate-pushdown.ts` — `sourceAttrs.findIndex(...)`; `agg.source` in hand.
- `planner/rules/sort/rule-orderby-fd-pruning.ts` — `sourceAttrs.findIndex(...)`; `source` in hand.
- `planner/rules/window/rule-monotonic-window.ts` — `sourceAttrs.findIndex(...)`; `node.source` in hand.
- `planner/rules/retrieve/rule-grow-retrieve.ts` — `tableAttrs.findIndex(...)`; `tableRef` in hand.

## Guidance / decisions from the first pass

- Sites where the helper takes a **raw `Attribute[]` with no owning node** (e.g. `deriveProjectionColumnMap` in `planner/util/key-utils.ts`, and `deriveOrderingFromMonotonicOn`) were intentionally left as array scans in the first pass — migrating them either ripples the signature into unit tests that hand-build `Attribute[]`, or forces building a throwaway local map (a micro-opt, not the cached surface). For those, either leave as-is (document why with a one-line comment, as done for `deriveProjectionColumnMap`) or push the lookup up to the caller that owns the node. Don't build a local map just to call `.get()`.
- Preserve exact miss semantics: scans that compared `>= 0` / `=== -1` map to `.get(id) ?? -1`; scans returning `undefined` on miss map to bare `.get(id)`.
- `createTableInfoFromNode` builds its `columnIndexMap` in a single pass (no scan to eliminate) — out of scope.

## Verification

- `yarn workspace @quereus/quereus run build` (the only thing that can break is a signature change like `deriveOrderingFromMonotonicOn` or `isOrderedForGrouping` if migrated — update all callers).
- `yarn test` — full suite green (no behavior change expected).
- `yarn workspace @quereus/quereus run lint`.
