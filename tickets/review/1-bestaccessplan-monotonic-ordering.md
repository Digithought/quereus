---
description: Review the BestAccessPlanResult monotonicOn / capability advertisements and the lift onto IndexScanNode / IndexSeekNode physical properties.
files: packages/quereus/src/vtab/best-access-plan.ts, packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/nodes/table-access-nodes.ts, packages/quereus/src/planner/rules/access/rule-select-access-path.ts, packages/quereus/src/vtab/memory/module.ts, packages/quereus/test/vtab/best-access-plan.spec.ts, packages/quereus/test/optimizer/bestaccessplan-monotonic-advertisement.spec.ts
---

## Summary

Adds three optional fields to `BestAccessPlanResult` so virtual-table modules can advertise monotonic-storage ordering and access-path capabilities, plus the planner-side plumbing that lifts those advertisements onto the physical leaf node's `physical.monotonicOn` / `physical.accessCapabilities`. The memory-table module sets the advertisements as a reference implementation so downstream optimizer-rule tickets have a non-Lamina vtab to validate against.

No optimizer rules consume the new fields yet — that is left to companion tickets (ordinal-seek pushdown, streaming asof, monotonic merge join, monotonic window fast paths).

## Interface changes

### `BestAccessPlanResult` (packages/quereus/src/vtab/best-access-plan.ts)

Three optional, additive fields:

| Field | Shape | Meaning |
|-------|-------|---------|
| `monotonicOn` | `{ columnIndex, direction: 'asc' \| 'desc', strict }` | Stronger than `providesOrdering`: the access path emits rows in monotonic non-decreasing (or non-increasing) order on the named column, as a property of the underlying storage. `strict = true` ⇒ no two rows share the value. |
| `supportsOrdinalSeek` | `boolean` | Path supports O(log N) seek to the kth monotonic row (LIMIT n OFFSET k can be pushed). Implies `monotonicOn`. |
| `supportsAsofRight` | `boolean` | Path can serve as the right side of a streaming asof scan: position to ≤ key in O(log avg-gap), advance forward without re-seek for monotonically increasing left keys. Implies `monotonicOn`. |

`validateAccessPlan` enforces the column-index range and the `*Right`/`*Seek` ⇒ `monotonicOn` implications.

The doc on `BestAccessPlanRequest.offset` is extended to clarify that modules advertising `supportsOrdinalSeek` consume `offset` directly as a seek-to-kth-row directive (the `LimitOffsetNode` above is still responsible — the comment mirrors the existing `limit + offset` guidance).

### `PhysicalProperties` (packages/quereus/src/planner/nodes/plan-node.ts)

Added `accessCapabilities?: { ordinalSeek?: boolean; asofRight?: boolean }`. These are not relational characteristics — they describe what the access path's iterator can be driven to do, so single-input pass-through nodes (Filter, Alias, LimitOffset) MUST NOT propagate them. The existing `monotonicOn` field added by the prereq ticket is the relational counterpart and follows its own propagation rules.

### Physical leaf nodes (packages/quereus/src/planner/nodes/table-access-nodes.ts)

`IndexScanNode` and `IndexSeekNode` now accept an optional `advertisement: AccessPathAdvertisement` constructor argument. Their `computePhysical()` lifts:
  - `advertisement.monotonicOn.columnIndex` → `physical.monotonicOn[0].attrId` (translation via `source.getAttributes()`).
  - `supportsOrdinalSeek` / `supportsAsofRight` → `physical.accessCapabilities`.

`SeqScanNode` does not advertise — it is only chosen when the access plan is non-monotonic.

### Planner rule (rule-select-access-path.ts)

`extractAdvertisement(plan)` packs the three result fields into an `AccessPathAdvertisement` (or `undefined` when none is set). Both the index-aware `selectPhysicalNodeFromPlan` and the legacy `selectPhysicalNodeLegacy` thread the advertisement into every `IndexScanNode` / `IndexSeekNode` constructor.

### Memory-table reference (packages/quereus/src/vtab/memory/module.ts)

`MemoryTableModule.findBestAccessPlan` calls `buildMonotonicAdvertisement` after finalizing the plan. The helper:
  - Skips multi-value-IN multi-seek and OR_RANGE paths (non-monotonic emit order).
  - Locates the chosen index via `bestPlan.indexName ?? bestPlan.orderingIndexName`.
  - Picks the leading non-equality-bound index column (skipping leading constants).
  - Returns `{}` if every column is equality-bound (single-row seek).
  - Strict iff the index is unique (PK or declared unique) AND the leading non-bound column is the only remaining unbound key column.
  - Direction follows the index column's `desc` flag.
  - Always advertises `supportsAsofRight` alongside `monotonicOn` (memory-table cursors advance forward without re-seek).

A TODO comment explicitly defers `supportsOrdinalSeek` — the layered store's scan does not cheaply support O(log N) seek to the kth row.

## Test coverage

### Unit tests — `packages/quereus/test/vtab/best-access-plan.spec.ts`
  - `validateAccessPlan` accepts a valid `monotonicOn`.
  - Rejects out-of-range / negative `monotonicOn.columnIndex`.
  - Rejects `supportsOrdinalSeek` / `supportsAsofRight` without `monotonicOn`.
  - Accepts both capability flags when accompanied by `monotonicOn`.

### Plan-shape tests — `packages/quereus/test/optimizer/bestaccessplan-monotonic-advertisement.spec.ts`
  - **Full PK scan, single-col PK** → strict `monotonicOn` + `accessCapabilities.asofRight: true` lifted onto the physical leaf.
  - **PK range scan** → strict `monotonicOn`.
  - **Composite PK full scan** → non-strict `monotonicOn` on leading column.
  - **Single-row equality seek** → no `monotonicOn`.
  - **Multi-value IN multi-seek** → no `monotonicOn` (IN-list emit order).
  - **EXPLAIN serialization** → `query_plan()` JSON contains `"monotonicOn"`, `"accessCapabilities"`, `"asofRight": true`.

## Validation

  - `yarn workspace @quereus/quereus exec tsc --noEmit` → exit 0.
  - `yarn build` (full repo) → green.
  - `yarn workspace @quereus/quereus test` → 2555 passing, 2 pending; no regressions.
  - `yarn workspace @quereus/quereus lint` → exit 0.

## Review focus / open questions

1. **Direction tracking when `adjustPlanForOrdering` reverses the natural index direction.** The advertisement currently uses `leadingCol.desc` as the source of truth for direction. When the planner picks an asc index to satisfy `ORDER BY … DESC` by reverse-walking, the emitted rows are descending while the advertisement still says `asc`. The memory-table doesn't actually do that today (asc/desc indexes are separate) but a future path could; the comment in `buildMonotonicAdvertisement` flags this.

2. **`accessCapabilities` propagation policy.** The current implementation does not propagate `accessCapabilities` through any pass-through node. That is deliberate (the leaf's iterator is the consumer's iterator only when the leaf is the consumer's direct child), but the field is present on `PhysicalProperties` rather than only on the leaf node — reviewers may want to verify nothing in characteristic queries inherits it accidentally. (None of the current `computePhysical` overrides reference it.)

3. **Strict-classification heuristic.** The "strict iff unique index AND single trailing non-bound column" rule is correct for the memory-table cases exercised, but a unique index with a *composite* free suffix (e.g., unique on `(a, b, c)` with `a` equality-bound, `b` and `c` free) would not get strict on `b` even though no two rows share `(a,b,c)` — `b` alone might still have duplicates within the path. The current `strict=false` is the conservative correct answer; flagging here so reviewers don't confuse it with a missed optimization.

4. **`RetrieveNode` propagation of `monotonicOn`.** The architecture comment in the implement ticket suggested verifying default child-inheritance is sufficient. In practice the rule replaces the `RetrieveNode` with its physical leaf (or pipeline above it) before the optimization run finishes, so the `RetrieveNode` rarely survives into the physical plan. No propagation override added; the default `get physical()` path only inherits `deterministic/idempotent/readonly`, so any node that *did* keep a `RetrieveNode` in the final plan would lose `monotonicOn` from its child — but that situation does not currently arise.

## End
