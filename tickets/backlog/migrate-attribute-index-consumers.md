description: Finish migrating the remaining ad-hoc `attrs.findIndex(a => a.id === …)` attribute-index scans to the cached `PlanNode.getAttributeIndex()` surface introduced by attribute-provenance-surface. DRY/consistency cleanup, not a correctness fix.
files: packages/quereus/src/planner/nodes/aggregate-node.ts, packages/quereus/src/planner/nodes/sort.ts, packages/quereus/src/planner/nodes/window-node.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/planner/util/key-utils.ts, packages/quereus/src/runtime/emit/bloom-join.ts, packages/quereus/src/runtime/emit/merge-join.ts, packages/quereus/src/runtime/emit/asof-scan.ts
----

## Background

`attribute-provenance-surface` added `PlanNode.getAttributeIndex(): ReadonlyMap<number, number>` — a cached per-instance `attrId → index` map — and migrated `bloom-join-node`, `merge-join-node`, and `rule-monotonic-range-access` off the hand-rolled `attrs.findIndex(a => a.id === id)` pattern.

Several other sites still do the linear scan by hand: `aggregate-node`, `sort`, `window-node`, `reference`, `key-utils`, various rules, and the runtime emitters (`emit/bloom-join.ts`, `emit/merge-join.ts`, `emit/asof-scan.ts`).

## Scope / expectations

- Replace `attrs.findIndex(a => a.id === id)` with `node.getAttributeIndex().get(id) ?? -1` wherever a relational **node** is in hand, preserving the existing `-1`-on-miss contract.
- **Caveat:** some emitter sites operate on a raw `Attribute[]` array with no owning node available — `getAttributeIndex()` is a node method, so those are *not* trivially migratable. Either thread the node through or leave them with a short note; do not contort the call sites.
- `createTableInfoFromNode` builds its own `columnIndexMap` by hand but also builds the `{id,name}` list in the same pass, so the gain there is marginal — evaluate before touching.

Low priority: the surface already exists; this is opportunistic cleanup, not blocking anything.
