description: Review the second/final pass of the DRY migration from ad-hoc `findIndex(a => a.id === …)` attribute-index scans to the cached `RelationalPlanNode.getAttributeIndex()` surface. No-behavior-change cleanup across optimizer rules + analysis.
files: packages/quereus/src/planner/analysis/constraint-extractor.ts, packages/quereus/src/planner/framework/physical-utils.ts, packages/quereus/src/planner/rules/join/equi-pair-extractor.ts, packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts, packages/quereus/src/planner/rules/join/rule-lateral-top1-asof.ts, packages/quereus/src/planner/rules/aggregate/rule-aggregate-streaming.ts, packages/quereus/src/planner/rules/predicate/rule-aggregate-predicate-pushdown.ts, packages/quereus/src/planner/rules/sort/rule-orderby-fd-pruning.ts, packages/quereus/src/planner/rules/window/rule-monotonic-window.ts, packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts, packages/quereus/src/planner/util/key-utils.ts
----

## What was done

Finished the DRY migration started in `migrate-attribute-index-consumers`. Replaced the remaining ad-hoc linear `attrs.findIndex(a => a.id === id)` scans with the cached `getAttributeIndex().get(id)` surface (defined on `PlanNode`, `planner/nodes/plan-node.ts:494`). Pure consistency/DRY change — every scan returns the same column index; the only translation is the documented miss-semantics mapping.

### Miss-semantics rule applied (the crux for review)

- Callers that compared `>= 0` / `< 0` / `=== -1` → `.get(id) ?? -1` (preserves the `-1` sentinel exactly).
- No caller in this pass wanted bare `undefined` on miss, so all sites use `?? -1`.

### Per-site changes

- **constraint-extractor.ts** `classifyForAggregate` — replaced the local `sourceAttrs` array with `sourceIndex = aggNode.source.getAttributeIndex()`; both group-by→source-col and table-col→source-col scans now use `sourceIndex.get(attrId) ?? -1`. Updated one stale `sourceAttrs` comment.
- **equi-pair-extractor.ts** `isOrderedOnEquiPairs` + `reorderEquiPairsForMerge` — both now use `source`/`left`'s `getAttributeIndex()`.
- **rule-join-physical-selection.ts** `createSortForEquiPairs` — uses `attrIndex.get(attrId) ?? -1` for the index, but **keeps `attrs = source.getAttributes()`** because the body still does `attrs[idx]` to read the `Attribute` for the ColumnReferenceNode. Note: this site never checked for a miss before (`attrs[idx]` on `-1` → `undefined`); behavior is unchanged (`attrIndex.get` on a present id always matches the old scan).
- **rule-lateral-top1-asof.ts** — inlined to `tableRef.getAttributeIndex().get(rightAttrId) ?? -1`; removed the now-unused `tableAttrs` local.
- **rule-aggregate-streaming.ts** `isOrderedForGrouping` — **signature change**: third param went from `sourceAttributes: readonly { id: number }[]` to `sourceAttrIndex: ReadonlyMap<number, number>`. Sole caller updated to pass `source.getAttributeIndex()`.
- **rule-aggregate-predicate-pushdown.ts** — migrated only the one group-by scan to `agg.source.getAttributeIndex().get(srcAttrId) ?? -1`. **Deliberately kept** the `sourceAttrs` array because it is also passed to `rewriteOutputToSource` (which does `.find(...)` on it, lines ~167–192) — that `.find` is a different lookup shape, out of scope.
- **rule-orderby-fd-pruning.ts** — replaced `sourceAttrs` local with `sourceIndex = source.getAttributeIndex()`; the single scan uses `?? -1`.
- **rule-monotonic-window.ts** — migrated the lead-column scan to `node.source.getAttributeIndex().get(leadAttrId) ?? -1`, but **keeps `sourceAttrs`** because line ~277 still does `sourceAttrs[o.column]` (index→attr lookup, opposite direction).
- **rule-grow-retrieve.ts** — replaced `tableAttrs` local with `tableAttrIndex = tableRef.getAttributeIndex()`; the sort-key scan uses `?? -1`.

### Intentionally left as array scans (decisions, not omissions)

- **physical-utils.ts** `deriveOrderingFromMonotonicOn` — takes a raw `attrs: readonly { id: number }[]` and **has zero callers in the source tree** (only referenced by a completed ticket doc). Nothing to push the lookup up to, and building a throwaway local map is a micro-opt, not the cached surface. Left as a scan with a new one-line comment explaining why (per first-pass guidance).
- **key-utils.ts** `deriveProjectionColumnMap` (lines 124, 142) — raw `Attribute[]` helper, explicitly declared out of scope by the first pass and this ticket. Untouched.

## Verification performed

- `yarn workspace @quereus/quereus run build` — clean (EXIT=0). The only signature change (`isOrderedForGrouping`) had its one caller updated.
- `yarn workspace @quereus/quereus run test` — **3637 passing, 9 pending, EXIT=0**.
- `yarn workspace @quereus/quereus run lint` — clean (EXIT=0).

## Review guidance / known gaps

- This is a no-behavior-change refactor, so there are **no new tests** — the existing optimizer/planner suite is the regression net. The reviewer should sanity-check that each migrated site's miss-semantics truly match the old `findIndex` (especially the two sites that retain the array variable: `rule-join-physical-selection` `attrs[idx]` and `rule-monotonic-window` `sourceAttrs[o.column]`).
- Worth a second look: in `createSortForEquiPairs`, confirm there's no path where `attrId` is absent from the source — both old and new code would index `attrs[-1]` → `undefined` and then read `.name`. Pre-existing behavior, not introduced here, but flagging since it's the one site without an explicit miss guard.
- Did **not** run `yarn test:store` (LevelDB path) — this change is in the planner, store-agnostic, and store tests are slow; deferred to CI/human per agent-runnable guidance.
- No docs needed updating — `getAttributeIndex()` was already documented on `PlanNode` by the first pass.
